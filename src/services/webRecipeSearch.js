import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Ti si asistent koji pretrazuje internet i pronalazi dobro ocenjene, proverene recepte sa reputabilnih izvora (poznati kuvarski sajtovi, sajtovi sa recenzijama/ocenama). Prioritet daj receptima koji imaju vidljive dobre ocene ili su sa poznatih/proverenih izvora.

Nakon pretrage, vrati ISKLJUCIVO validan JSON (bez ikakvog dodatnog teksta pre ili posle) u formatu:
{
  "recipes": [
    {
      "title": "naziv jela",
      "sourceUrl": "puna adresa stranice odakle je recept",
      "servings": broj ili null,
      "ingredients": [{"name": "naziv sastojka", "amount": "kolicina"}],
      "steps": ["korak 1", "korak 2"],
      "prepTimeMinutes": broj ili null,
      "tags": ["kategorija"],
      "nutritionPerServing": {"calories": broj ili null, "proteinGrams": broj ili null, "carbsGrams": broj ili null, "fatGrams": broj ili null}
    }
  ]
}
Koristi domace mere (šolja, kašika, g, ml) kad god je prirodno. Svaki recept mora imati stvaran sourceUrl sa stranice koju si pronasao pretragom — ne izmisljaj linkove.`;

/**
 * Pretrazuje internet (Claude web_search alat) za recepte koji odgovaraju
 * ogranicenjima, i vraca ih kao strukturirane recepte spremne za cuvanje.
 */
export async function findRecipesOnline(constraints, count = 6) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: `${SYSTEM_PROMPT}\n\nPotrebno je oko ${count} razlicitih recepata.`,
    messages: [
      {
        role: 'user',
        content: `Ogranicenja: ${constraints || 'nema posebnih — izaberi popularne, dobro ocenjene recepte za svakodnevno kuvanje'}`,
      },
    ],
  });

  // Poslednji tekstualni blok sadrzi finalni odgovor (posle eventualnih
  // tool_use/tool_result blokova iz pretrage)
  const textBlock = [...message.content].reverse().find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI nije vratio tekstualni odgovor nakon pretrage.');

  let cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Nisam uspeo da obradim rezultate pretrage. Probaj ponovo.');
  }

  const recipes = parsed.recipes || [];
  return recipes.map((r) => ({
    id: randomUUID(),
    title: r.title || 'Recept sa interneta',
    sourceUrl: r.sourceUrl || 'web-search',
    sourcePlatform: 'other',
    servings: r.servings ?? null,
    ingredients: r.ingredients || [],
    steps: r.steps || [],
    prepTimeMinutes: r.prepTimeMinutes ?? null,
    tags: r.tags || [],
    nutritionPerServing: r.nutritionPerServing || null,
    createdAt: new Date().toISOString(),
  }));
}
