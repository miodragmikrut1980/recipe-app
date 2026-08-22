import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractJson(message) {
  const textBlock = message.content.find((b) => b.type === 'text');
  let cleaned = textBlock.text.replace(/```json|```/g, '').trim();

  // AI ponekad doda tekst/kod POSLE glavnog JSON objekta (drugi blok,
  // objasnjenje, i sl). Trazenje "poslednje }" u tom slucaju pokupi previse.
  // Umesto toga: nadji prvu { i broji zagrade dok se ne vrate na 0 — to je
  // pravi kraj tog JSON objekta, bez obzira sta dolazi posle.
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

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error('AI nije vratio ocekivan format odgovora. Probaj ponovo ili promeni ogranicenja.');
  }
}

/**
 * "Sta mogu da skuvam od ovoga?" — korisnik navede sta ima kod kuce, AI
 * pretrazi njegove sacuvane recepte i predlozi koje moze da napravi (ili
 * skoro napravi, uz par sastojaka koji fale).
 */
export async function suggestRecipesFromIngredients(availableIngredients, savedRecipes) {
  const recipeSummaries = savedRecipes.map((r) => ({
    id: r.id,
    title: r.title,
    ingredients: r.ingredients.map((i) => i.name),
  }));

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: `Korisnik ti daje spisak namirnica koje ima kod kuce i listu njegovih sacuvanih recepata (samo naslovi i sastojci). Vrati ISKLJUCIVO JSON:
{
  "matches": [
    {"recipeId": "id", "matchType": "full" ili "partial", "missingIngredients": ["sastojak1"]}
  ]
}
"full" znaci da ima sve sastojke. "partial" znaci da mu fali malo (do 2-3 stavke) — navedi tacno sta fali u missingIngredients. Preskoci recepte kojima fali previse sastojaka (vise od 3). Sortiraj rezultat tako da "full" budu prvi.`,
    messages: [
      {
        role: 'user',
        content: `Imam: ${availableIngredients.join(', ')}\n\nMoji recepti:\n${JSON.stringify(recipeSummaries)}`,
      },
    ],
  });

  return extractJson(message).matches;
}

/**
 * Prilagodjava postojeci recept po instrukciji korisnika (npr. "vegansko",
 * "duplo manje porcija", "bez glutena", "zameni piletinu ciljetom").
 * Vraca NOVI recept objekat — original ostaje netaknut.
 */
export async function customizeRecipe(originalRecipe, instruction) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: `Dobices postojeci recept kao JSON i instrukciju za izmenu. Vrati IZMENJEN recept u ISTOM JSON formatu (title, servings, ingredients, steps, prepTimeMinutes, tags, nutritionPerServing), primenjujuci trazenu izmenu dosledno kroz sastojke I korake. Naslov promeni da odrazava izmenu (npr. dodaj "veganska verzija" ili "za 2 osobe"). Vrati ISKLJUCIVO JSON, bez dodatnog teksta.`,
    messages: [
      {
        role: 'user',
        content: `Recept: ${JSON.stringify(originalRecipe)}\n\nIzmena: ${instruction}`,
      },
    ],
  });

  const parsed = extractJson(message);
  return {
    id: randomUUID(),
    title: parsed.title,
    sourceUrl: originalRecipe.sourceUrl,
    sourcePlatform: originalRecipe.sourcePlatform,
    servings: parsed.servings ?? null,
    ingredients: parsed.ingredients || [],
    steps: parsed.steps || [],
    prepTimeMinutes: parsed.prepTimeMinutes ?? null,
    tags: parsed.tags || [],
    nutritionPerServing: parsed.nutritionPerServing || null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generise nedeljni plan obroka od sacuvanih recepata korisnika, postujuci
 * ogranicenja (npr. "bez svinjetine", "budzet do X", "brzo za radne dane").
 */
export async function generateWeeklyMealPlan(savedRecipes, constraints, days) {
  const recipeSummaries = savedRecipes.map((r) => ({
    id: r.id,
    title: r.title,
    tags: r.tags,
    prepTimeMinutes: r.prepTimeMinutes,
  }));

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Napravi plan obroka za ${days} dana koristeci ISKLJUCIVO recepte iz liste koju dobijes (po id-ju). Postuj navedena ogranicenja — ako ogranicenje trazi "decji meni" ili slicno, biraj iz liste recepte koji su blagi, jednostavni, bez ljutih zacina, sa poznatim/omiljenim decjim ukusima (npr. testenina, palacinke, piletina, jednostavni sendvici), a izbegavaj alkohol u receptu, jako ljuto, ili neobicne/egzoticne sastojke koje deca obicno ne vole. Ako nema dovoljno raznovrsnih recepata za sve obroke, ponovi neke — nemoj izmisljati recepte koji nisu na listi. Ako NIJEDAN recept sa liste ne odgovara ogranicenjima, vrati prazan niz umesto da odbijes zadatak.
Vrati ISKLJUCIVO validan JSON, bez ikakvog uvodnog ili zavrsnog teksta, objasnjenja ili izvinjenja — cak i ako ogranicenja ne mogu potpuno da se ispune:
{
  "plan": [
    {"dayOffset": 0, "mealType": "lunch", "recipeId": "id"},
    {"dayOffset": 0, "mealType": "dinner", "recipeId": "id"}
  ]
}
dayOffset je 0 za danas, 1 za sutra, itd. Koristi mealType vrednosti: "breakfast", "lunch", "dinner".`,
    messages: [
      {
        role: 'user',
        content: `Ogranicenja: ${constraints || 'nema posebnih'}\n\nDostupni recepti:\n${JSON.stringify(recipeSummaries)}`,
      },
    ],
  });

  const plan = extractJson(message).plan;
  if (!Array.isArray(plan) || plan.length > days * 3) throw new Error('AI plan nema očekivan format.');
  const allowedIds = new Set(savedRecipes.map((recipe) => recipe.id));
  const allowedMeals = new Set(['breakfast', 'lunch', 'dinner']);
  const seen = new Set();
  return plan.map((item) => {
    if (!item || !Number.isInteger(item.dayOffset) || item.dayOffset < 0 || item.dayOffset >= days || !allowedMeals.has(item.mealType) || !allowedIds.has(item.recipeId)) {
      throw new Error('AI plan sadrži nevažeću stavku. Probaj ponovo.');
    }
    const key = `${item.dayOffset}:${item.mealType}`;
    if (seen.has(key)) throw new Error('AI plan sadrži dupliran obrok. Probaj ponovo.');
    seen.add(key);
    return { dayOffset: item.dayOffset, mealType: item.mealType, recipeId: item.recipeId };
  });
}
