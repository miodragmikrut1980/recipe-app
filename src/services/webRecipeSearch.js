import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { httpUrl, normalizeAiRecipe } from '../lib/validation.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EFFICIENCY_NOTE = `\n\nVAZNO ZA TROSKOVE: Koristi NAJVISE 2-3 web pretrage ukupno da pronadjes sve potrebne recepte — nemoj pretrazivati odvojeno za svaki recept ili unakrsno proveravati svaki izvor pojedinacno. Budi efikasan: nekoliko dobro sastavljenih pretraga treba da ti daju dovoljno materijala za sve trazene recepte odjednom.`;

const SYSTEM_PROMPT_STANDARD = `Ti si asistent koji pretrazuje internet i pronalazi dobro ocenjene, proverene recepte sa reputabilnih izvora (poznati kuvarski sajtovi, sajtovi sa recenzijama/ocenama). Prioritet daj receptima koji imaju vidljive dobre ocene ili su sa poznatih/proverenih izvora. Ako ogranicenje trazi "decji meni" ili slicno, trazi ISKLJUCIVO recepte pogodne deci — blagi ukusi, bez ljutih zacina i alkohola, jednostavni za jelo, sa sastojcima koje vecina dece voli.${EFFICIENCY_NOTE}`;

const SYSTEM_PROMPT_TOP_RATED = `Ti si asistent koji pretrazuje internet i pronalazi ISKLJUCIVO najbolje moguce ocenjene recepte — vrh vrha, ne samo "dobre". Trazi recepte sa najvišim mogucim ocenama (4.8-5 od 5, ili ekvivalent), veliki broj recenzija (sto vise glasova/komentara, to bolje — to potvrdjuje da ocena nije slucajna), i sa najreputabilnijih, najpoznatijih izvora u datoj kategoriji. Ako moras da biras izmedju recepta sa odlicnom ocenom ali malo recenzija i recepta sa malo nizom ocenom ali mnogo recenzija, uzmi onaj sa vise recenzija — pouzdanija ocena. Ako ogranicenje trazi "decji meni" ili slicno, trazi najbolje ocenjene recepte KOJI SU I pogodni deci.${EFFICIENCY_NOTE}`;

const RESPONSE_FORMAT = `
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
VAZNO: u tekstu (title, ingredients, steps) NIKAD ne koristi obican navodnik (") unutar vrednosti — ako moras da citiras nesto, koristi obican apostrof (') ili parafraziraj. Koristi domace mere (šolja, kašika, g, ml) kad god je prirodno. Svaki recept mora imati stvaran sourceUrl sa stranice koju si pronasao pretragom — ne izmisljaj linkove.`;

/**
 * Pretrazuje internet (Claude web_search alat) za recepte. Podesavanja
 * ovde su svesno optimizovana za trosak: manje trazenih recepata, ogranicen
 * broj pretraga, manji max_tokens — plan i dalje pokriva nedelju jer se
 * recepti ponavljaju kroz dane (vidi routes/smartFeatures.js).
 */
export async function findRecipesOnline(constraints, count = 6, topRatedOnly = false) {
  const basePrompt = topRatedOnly ? SYSTEM_PROMPT_TOP_RATED : SYSTEM_PROMPT_STANDARD;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: `${basePrompt}${RESPONSE_FORMAT}\n\nPotrebno je oko ${count} razlicitih recepata.`,
    messages: [
      {
        role: 'user',
        content: `Ogranicenja: ${constraints || 'nema posebnih — izaberi popularne, dobro ocenjene recepte za svakodnevno kuvanje'}`,
      },
    ],
  });

  const textBlock = [...message.content].reverse().find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI nije vratio tekstualni odgovor nakon pretrage.');

  let cleaned = textBlock.text.replace(/```json|```/g, '').trim();

  const start = cleaned.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) cleaned = cleaned.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error(`JSON parse neuspesan (duzina odgovora: ${cleaned.length} karaktera). Greska: ${parseErr.message}`);
    throw new Error('Nisam uspeo da obradim rezultate pretrage. Probaj ponovo.');
  }

  const recipes = parsed.recipes || [];
  return recipes.map((raw) => {
    const r = normalizeAiRecipe(raw);
    return {
      id: randomUUID(),
      title: r.title,
      sourceUrl: httpUrl(raw.sourceUrl, 'sourceUrl'),
      sourcePlatform: 'other',
      servings: r.servings,
      ingredients: r.ingredients,
      steps: r.steps,
      prepTimeMinutes: r.prepTimeMinutes,
      tags: r.tags,
      nutritionPerServing: r.nutritionPerServing,
      createdAt: new Date().toISOString(),
    };
  });
}
