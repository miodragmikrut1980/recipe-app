/**
 * Link unfurling — cita javne og: meta tagove sa stranice posta, na isti
 * nacin kao sto WhatsApp/Slack/Viber prave preview linka. Jedan GET zahtev
 * po linku koji je korisnik licno podelio, bez logovanja i bez preuzimanja
 * medija. Instagram u og:description drzi caption posta.
 *
 * Napomena o riziku: Instagram ToS siroko zabranjuje automatizovan pristup;
 * unfurling pojedinacnih korisnicki-podeljenih linkova je industrijski
 * standard i najblazi oblik, ali nije formalno odobren — svesna odluka
 * vlasnika proizvoda (vidi razgovor o UX pojednostavljenju).
 */
import { fetchPublicHtml } from './safeRemoteFetch.js';

const BROWSER_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractMeta(html, property) {
  // <meta property="og:description" content="..."> u oba redosleda atributa
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

/**
 * YouTube specificnost: og:description je skracen na ~150 karaktera, a
 * recepti u opisima YouTube videa su cesto dugacki. Pun opis stoji u
 * "shortDescription" polju JSON-a ugradjenog u samu stranicu.
 */
function extractYouTubeDescription(html) {
  const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`); // odmotava \n, \" i unicode eskejpove
  } catch {
    return null;
  }
}

/**
 * Vraca { caption, title } ili null ako nista upotrebljivo nije nadjeno
 * (privatan nalog, obrisan post, blokiran zahtev...). Nikad ne baca gresku
 * ka pozivaocu — auto-tok tiho pada na rucni unos.
 */
export async function fetchLinkPreview(url) {
  try {
    const result = await fetchPublicHtml(url, { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en' });
    if (!result) return null;
    const { html } = result;

    const description = extractMeta(html, 'og:description');
    const title = extractMeta(html, 'og:title');

    // YouTube: probaj pun opis iz ugradjenog JSON-a (og je skracen)
    const isYouTube = /youtube\.com|youtu\.be/.test(url);
    const fullDescription = isYouTube ? extractYouTubeDescription(html) : null;

    if (!description && !title && !fullDescription) return null;

    // Instagram og:description format: '123 likes, 4 comments - user on date: "caption"'
    // Izvuci deo pod navodnicima ako postoji, inace koristi ceo description
    let caption = fullDescription || description || '';
    if (!fullDescription) {
      const quoted = caption.match(/: "([\s\S]+)"$/);
      if (quoted) caption = quoted[1];
    }

    return { caption: caption.trim(), title: title || null };
  } catch (err) {
    console.warn(`Link preview nije uspeo za ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Gruba provera: da li tekst uopste lici na recept (dovoljno dug i pominje
 * bar nesto kulinarsko)? Sprecava da AI "izmisli" recept od praznog captiona
 * tipa "So good 😍 #food".
 */
export function looksLikeRecipe(text) {
  if (!text || text.trim().length < 80) return false;
  const foodHints = /sastojc|recept|ingredient|recipe|kasik|kašik|šolj|solj|gram|\d+\s?(g|ml|kg|cup|tbsp|tsp)|instructions|priprema|method|steps/i;
  return foodHints.test(text);
}
