import dns from 'dns/promises';
import net from 'net';
import http from 'node:http';
import https from 'node:https';
import { HttpError } from '../lib/httpError.js';

const MAX_REDIRECTS = 4;
const MAX_BYTES = 2 * 1024 * 1024;
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function mappedIpv4(address) {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isBlockedIp(address) {
  if (!net.isIP(address)) return true;
  if (net.isIPv6(address)) {
    const ipv4 = mappedIpv4(address);
    if (ipv4) return isBlockedIp(ipv4);
    const ip = address.toLowerCase();
    return ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function resolvePublicUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new HttpError(400, 'Nevažeći URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, 'Dozvoljeni su samo javni http/https URL-ovi');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new HttpError(400, 'Privatne mrežne adrese nisu dozvoljene');
  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  else {
    try {
      const raw = await dns.lookup(hostname, { all: true, verbatim: true });
      console.log(`[DNS-DEBUG-v2] hostname=${hostname} raw=${JSON.stringify(raw)}`);
      addresses = raw.filter((a) => a && typeof a.address === 'string' && net.isIP(a.address));
      console.log(`[DNS-DEBUG-v2] posle filtera: ${JSON.stringify(addresses)}`);
    } catch (dnsErr) {
      console.log(`[DNS-DEBUG-v2] dns.lookup baca gresku: ${dnsErr.message}`);
      throw new HttpError(422, 'Domen nije moguće pronaći');
    }
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) throw new HttpError(400, 'Privatne mrežne adrese nisu dozvoljene');
  return { url, address: addresses[0] };
}

function requestPinned(url, address, headers) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET', headers, timeout: 8000,
      lookup(_hostname, _options, callback) { callback(null, address.address, address.family); },
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          request.destroy(new HttpError(422, 'Stranica je prevelika za obradu'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new HttpError(504, 'Izvor nije odgovorio na vreme')));
    request.on('error', reject);
    request.end();
  });
}

export async function fetchPublicHtml(rawUrl, headers = {}) {
  let current = rawUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const { url, address } = await resolvePublicUrl(current);
    const response = await requestPinned(url, address, { ...headers, Host: url.host, Accept: 'text/html,application/xhtml+xml' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw new HttpError(422, 'Neispravno preusmerenje izvora');
      current = new URL(location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) return null;
    const contentType = response.headers['content-type'] || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new HttpError(422, 'URL ne vodi do HTML stranice');
    return { url: url.toString(), html: response.body };
  }
  throw new HttpError(422, 'Previše URL preusmerenja');
}
