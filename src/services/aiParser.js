import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Ti si asistent koji iz teksta objave sa drustvenih mreza izvlaci recept i vraca ga ISKLJUCIVO kao validan JSON, bez ikakvog dodatnog teksta, markdowna ili objasnjenja. Format:
{
  "title": "naziv jela",
  "servings": broj ili null,
  "ingredients": [{"name": "naziv sastojka", "amount": "kolicina ili prazan string"}],
  "steps": ["korak 1", "korak 2"],
  "prepTimeMinutes": broj ili null,
  "tags": ["kategorija1", "kategorija2"],
  "nutritionPerServing": {
    "calories": broj ili null,
    "proteinGrams": broj ili null,
    "carbsGrams": broj ili null,
    "fatGrams": broj ili null
  }
}
Za nutritionPerServing napravi razumnu procenu na osnovu sastojaka i broja porcija — jasno je da nije precizno kao laboratorijska analiza, samo okvirna procena, ali daj konkretne brojeve, ne null, osim ako sastojci uopste nisu poznati.
Za amount koristi domace mere kad god je prirodno (šolja, kašika, kašičica, čaša, kg, g, ml) umesto amerických mera (cup, tbsp, tsp, oz) — konvertuj ako original koristi americke mere. Nazive sastojaka piši na srpskom jeziku ako je original na srpskom ili srodnom jeziku.
Ako tekst ne sadrzi dovoljno informacija za neko polje, iskoristi razumnu procenu na osnovu konteksta ili ostavi prazno/null. Nikad ne izmisljaj sastojke koji se ne pominju niti nagovestavaju u tekstu.`;

/**
 * Salje sirovi tekst objave (caption i/ili transkript videa) Claude-u
 * i vraca strukturiran objekat recepta. Kad postoje OBA izvora, salju se
 * zajedno — caption cesto ima tacne kolicine, a transkript postupak.
 */
export async function parseRecipeFromText(rawText, sourceUrl, extraContext = null) {
  const content = extraContext
    ? `OPIS OBJAVE (caption):\n${extraContext}\n\nTRANSKRIPT GOVORA IZ VIDEA:\n${rawText}`
    : rawText;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error('AI odgovor ne sadrzi tekstualni deo');
  }

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  return {
    id: randomUUID(),
    title: parsed.title || 'Nepoznat recept',
    sourceUrl,
    sourcePlatform: detectPlatform(sourceUrl),
    servings: parsed.servings ?? null,
    ingredients: parsed.ingredients || [],
    steps: parsed.steps || [],
    prepTimeMinutes: parsed.prepTimeMinutes ?? undefined,
    tags: parsed.tags || [],
    nutritionPerServing: parsed.nutritionPerServing || null,
    createdAt: new Date().toISOString(),
  };
}

function detectPlatform(url) {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('pinterest.')) return 'pinterest';
  if (url === 'shared-video' || url === 'scanned-photo') return 'other';
  return 'other';
}
