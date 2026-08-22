import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectFileKind, verifyUploadedFile } from '../src/lib/fileSignature.js';
import { errorEnvelope, errorSummary, redact } from '../src/lib/logger.js';
import { buildPlanEntries } from '../src/lib/planEntries.js';
import { validateIdempotencyKey } from '../src/lib/idempotencyKey.js';
import { safeMonitoringPayload } from '../src/lib/monitoringPayload.js';

const bytes = (...values) => Buffer.from(values);

test('magic bytes prepoznaju podržane slike', () => {
  assert.equal(detectFileKind(Buffer.concat([bytes(0xff, 0xd8, 0xff), Buffer.alloc(12)])), 'image/jpeg');
  assert.equal(detectFileKind(Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(4)])), 'image/png');
  assert.equal(detectFileKind(Buffer.from('GIF89a000000')), 'image/gif');
  assert.equal(detectFileKind(Buffer.from('RIFF0000WEBP')), 'image/webp');
});

test('magic bytes prepoznaju podržane video formate', () => {
  assert.equal(detectFileKind(Buffer.from('0000ftyp0000')), 'video/mp4');
  assert.equal(detectFileKind(Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.alloc(8)])), 'video/webm');
  assert.equal(detectFileKind(Buffer.from('RIFF0000AVI ')), 'video/x-msvideo');
});

test('nepoznat ili prekratak sadržaj nije prihvaćen', () => {
  assert.equal(detectFileKind(Buffer.from('tekst')), null);
  assert.equal(detectFileKind(Buffer.alloc(16, 7)), null);
});

test('upload provera ne veruje ekstenziji fajla', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recipe-upload-'));
  const fakeImage = join(directory, 'recept.jpg');
  writeFileSync(fakeImage, Buffer.from('ovo nije slika'));
  assert.throws(() => verifyUploadedFile(fakeImage, 'image'), (error) => error.status === 415);
});

test('redakcija uklanja tokene, API ključeve i e-mail adrese', () => {
  const value = redact('Bearer abc.def sk-test123 sk-ant-test456 sb_secret_test osoba@example.com');
  assert.equal(value.includes('abc.def'), false);
  assert.equal(value.includes('sk-test'), false);
  assert.equal(value.includes('osoba@example.com'), false);
  assert.match(value, /\[REDACTED\]/);
});

test('log polja su ograničena na bezbednu dužinu', () => {
  assert.equal(redact('x'.repeat(700)).length, 500);
});

test('error summary ne izlaže stack u produkciji', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const summary = errorSummary(Object.assign(new Error('greška za a@b.rs'), { code: 'E_TEST', status: 400 }));
  if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
  assert.equal('stack' in summary, false);
  assert.equal(summary.message.includes('a@b.rs'), false);
  assert.equal(summary.code, 'E_TEST');
  assert.equal(summary.status, 400);
});

test('plan pretvara dayOffset u datume i čuva tip obroka', () => {
  const entries = buildPlanEntries([
    { dayOffset: 0, mealType: 'breakfast', recipeId: 'r1' },
    { dayOffset: 2, mealType: 'dinner', recipeId: 'r2' },
  ], new Date(2026, 7, 22), ['r1', 'r2']);
  assert.deepEqual(entries, [
    { date: '2026-08-22', mealType: 'breakfast', recipeId: 'r1' },
    { date: '2026-08-24', mealType: 'dinner', recipeId: 'r2' },
  ]);
});

test('plan odbija recept koji korisniku nije dostupan', () => {
  assert.throws(() => buildPlanEntries([
    { dayOffset: 0, mealType: 'lunch', recipeId: 'tuđi' },
  ], new Date(2026, 7, 22), ['moj']), /nedostupan recipeId/);
});

test('plan odbija nevažeće dane, tipove i veličinu', () => {
  assert.throws(() => buildPlanEntries([], new Date()), /1-42/);
  assert.throws(() => buildPlanEntries([{ dayOffset: 14, mealType: 'lunch', recipeId: 'r1' }]), /dayOffset/);
  assert.throws(() => buildPlanEntries([{ dayOffset: 0, mealType: 'snack', recipeId: 'r1' }]), /mealType/);
});

test('idempotency ključ dozvoljava samo ograničen bezbedan format', () => {
  assert.equal(validateIdempotencyKey('plan:abc-123'), 'plan:abc-123');
  assert.equal(validateIdempotencyKey(undefined), null);
  assert.throws(() => validateIdempotencyKey('kratko'));
  assert.throws(() => validateIdempotencyKey('ključ sa razmakom'));
  assert.throws(() => validateIdempotencyKey('x'.repeat(129)));
});

function configCheck(environment) {
  return spawnSync(process.execPath, ['-e', "import('./src/config.js')"], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { PATH: process.env.PATH, ...environment },
    encoding: 'utf8',
  });
}

test('server odbija pokretanje bez obaveznih tajni', () => {
  const result = configCheck({ NODE_ENV: 'production' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Nedostaju obavezne environment promenljive/);
});

test('server odbija HTTP Supabase URL u produkciji', () => {
  const result = configCheck({
    NODE_ENV: 'production', SUPABASE_URL: 'http://example.test', SUPABASE_SERVICE_KEY: 'test',
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', CORS_ORIGINS: 'https://app.example.test',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mora koristiti HTTPS/);
});

test('kompletna produkciona env konfiguracija prolazi', () => {
  const result = configCheck({
    NODE_ENV: 'production', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'test',
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', CORS_ORIGINS: 'https://app.example.test',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('server odbija nevažeći AI limit i nesiguran monitoring URL', () => {
  const base = {
    NODE_ENV: 'production', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'test',
    ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', CORS_ORIGINS: 'https://app.example.test',
  };
  const invalidLimit = configCheck({ ...base, AI_DAILY_USER_CREDITS: '0' });
  assert.notEqual(invalidLimit.status, 0);
  assert.match(invalidLimit.stderr, /AI_DAILY_USER_CREDITS/);
  const insecureWebhook = configCheck({ ...base, ERROR_WEBHOOK_URL: 'http://monitor.example.test/hook' });
  assert.notEqual(insecureWebhook.status, 0);
  assert.match(insecureWebhook.stderr, /mora koristiti HTTPS/);
});

test('monitoring payload odbacuje neočekivana i osetljiva polja', () => {
  const payload = safeMonitoringPayload('backend_error', 'critical', {
    requestId: 'request-123', route: '/parse-recipe', status: 500,
    token: 'Bearer tajni-token', recipeText: 'porodični recept', errorName: 'Error za a@b.rs',
  }, 'test');
  assert.equal(payload.requestId, 'request-123');
  assert.equal(payload.status, '500');
  assert.equal(payload.errorName.includes('a@b.rs'), false);
  assert.equal('token' in payload, false);
  assert.equal('recipeText' in payload, false);
});

test('svaki JSON error odgovor dobija requestId', () => {
  let output;
  const req = { requestId: 'request-abc123' };
  const res = { statusCode: 404, json(body) { output = body; return body; } };
  let continued = false;
  errorEnvelope(req, res, () => { continued = true; });
  res.json({ error: 'Nije pronađeno' });
  assert.equal(continued, true);
  assert.deepEqual(output, { error: 'Nije pronađeno', requestId: 'request-abc123' });
});
