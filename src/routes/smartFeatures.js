import { Router } from 'express';
import { listRecipes, saveRecipe } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { setMealPlanEntry } from '../services/mealPlan.js';
import { findRecipesOnline } from '../services/webRecipeSearch.js';
import { getMyRatings } from '../services/ratings.js';
import {
  suggestRecipesFromIngredients,
  customizeRecipe,
  generateWeeklyMealPlan,
} from '../services/smartFeatures.js';
import { integerValue, stringArray, stringValue, uuidValue } from '../lib/validation.js';
import { sendRouteError } from '../lib/httpError.js';

const router = Router();
router.use(requireAuth);

/**
 * "Sta mogu da skuvam od ovoga?" — POST { availableIngredients: string[] }
 */
router.post('/suggest-recipes', async (req, res) => {
  const { availableIngredients } = req.body;
  if (!Array.isArray(availableIngredients) || availableIngredients.length === 0) {
    return res.status(400).json({ error: 'Nedostaje "availableIngredients" (niz stringova)' });
  }
  try {
    const validIngredients = stringArray(availableIngredients, 'availableIngredients', { min: 1, max: 100, itemMax: 100 });
    const savedRecipes = await listRecipes(req.user.id);
    if (savedRecipes.length === 0) {
      return res.json({ matches: [] });
    }
    const matches = await suggestRecipesFromIngredients(validIngredients, savedRecipes);
    res.json({ matches });
  } catch (err) {
    console.error('Greska pri predlaganju recepata:', err);
    sendRouteError(res, err, 'Predlaganje recepata nije uspelo');
  }
});

/**
 * Prilagodjavanje recepta — POST { recipeId, instruction }
 * Cuva rezultat kao NOV recept (original ostaje netaknut).
 */
router.post('/customize-recipe', async (req, res) => {
  const { recipeId, instruction } = req.body;
  if (!recipeId || !instruction) {
    return res.status(400).json({ error: 'Nedostaju "recipeId" ili "instruction"' });
  }
  try {
    const validRecipeId = uuidValue(recipeId, 'recipeId');
    const validInstruction = stringValue(instruction, 'instruction', { max: 1000 });
    const savedRecipes = await listRecipes(req.user.id);
    const original = savedRecipes.find((r) => r.id === validRecipeId);
    if (!original) {
      return res.status(404).json({ error: 'Recept nije pronadjen' });
    }
    const customized = await customizeRecipe(original, validInstruction);
    const saved = await saveRecipe(customized, req.user.id);
    res.json({ recipe: saved });
  } catch (err) {
    console.error('Greska pri prilagodjavanju recepta:', err);
    sendRouteError(res, err, 'Prilagođavanje recepta nije uspelo');
  }
});

/**
 * Generisanje nedeljnog plana — POST { constraints?, days? }
 * Odmah upisuje generisan plan u meal_plan tabelu.
 */
router.post('/meal-plan/generate', async (req, res) => {
  const { constraints, days = 7, favoritesOnly = false } = req.body;
  try {
    const validDays = integerValue(days, 'days', { min: 1, max: 14, defaultValue: 7 });
    const validConstraints = constraints == null ? undefined : stringValue(constraints, 'constraints', { required: false, max: 2000 });
    let savedRecipes = await listRecipes(req.user.id);

    if (favoritesOnly) {
      const ratings = await getMyRatings(req.user.id);
      savedRecipes = savedRecipes.filter((r) => (ratings[r.id] || 0) >= 4);
      if (savedRecipes.length === 0) {
        return res.status(422).json({
          error: 'Nemaš još recepata ocenjenih sa 4 ili 5 zvezdica. Oceni bar par recepata da bi ih koristio kao favorite.',
        });
      }
    }

    if (savedRecipes.length === 0) {
      return res.status(422).json({ error: 'Nemas jos sacuvanih recepata za generisanje plana.' });
    }

    const plan = await generateWeeklyMealPlan(savedRecipes, validConstraints, validDays);

    if (plan.length === 0) {
      return res.status(422).json({
        error: 'Nijedan sačuvan recept ne odgovara ovim ograničenjima. Probaj šira ograničenja ili sačuvaj još recepata.',
      });
    }

    const today = new Date();
    const writtenEntries = [];
    for (const item of plan) {
      const date = new Date(today);
      date.setDate(today.getDate() + item.dayOffset);
      // Lokalne komponente umesto toISOString (UTC) da datum ne sklizne za dan
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const entry = await setMealPlanEntry({
        date: dateStr,
        mealType: item.mealType,
        recipeId: item.recipeId,
      }, req.user.id);
      writtenEntries.push(entry);
    }

    res.json({ entries: writtenEntries });
  } catch (err) {
    console.error('Greska pri generisanju plana:', err);
    sendRouteError(res, err, 'Generisanje plana nije uspelo');
  }
});

/**
 * Kad korisnik nema (dovoljno) sacuvanih recepata: pretrazi internet za
 * dobro ocenjene recepte, sacuvaj ih kao prave recepte u kolekciji, i
 * odmah sastavi plan za trazeni broj dana (rucak + vecera svaki dan).
 */
router.post('/meal-plan/generate-online', async (req, res) => {
  const { constraints, days = 7, topRatedOnly = false } = req.body;
  try {
    const validDays = integerValue(days, 'days', { min: 1, max: 14, defaultValue: 7 });
    const validConstraints = constraints == null ? undefined : stringValue(constraints, 'constraints', { required: false, max: 2000 });
    const neededCount = Math.min(validDays * 2, 10); // rucak+vecera po danu, max 10
    const foundRecipes = await findRecipesOnline(validConstraints, neededCount, Boolean(topRatedOnly));

    if (foundRecipes.length === 0) {
      return res.status(422).json({
        error: topRatedOnly
          ? 'Nisam pronašao dovoljno vrhunski ocenjenih recepata za ova ograničenja. Probaj šira ograničenja.'
          : 'Nisam pronašao odgovarajuće recepte na internetu. Probaj drugačija ograničenja.',
      });
    }

    const savedRecipes = [];
    for (const recipe of foundRecipes) {
      savedRecipes.push(await saveRecipe(recipe, req.user.id));
    }

    const today = new Date();
    const mealTypes = ['lunch', 'dinner'];
    const writtenEntries = [];
    let idx = 0;

    for (let d = 0; d < validDays; d++) {
      for (const mealType of mealTypes) {
        const recipe = savedRecipes[idx % savedRecipes.length];
        idx++;
        const date = new Date(today);
        date.setDate(today.getDate() + d);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const entry = await setMealPlanEntry({ date: dateStr, mealType, recipeId: recipe.id }, req.user.id);
        writtenEntries.push(entry);
      }
    }

    res.json({ entries: writtenEntries, recipesFound: savedRecipes.length });
  } catch (err) {
    console.error('Greska pri pretrazi recepata na internetu:', err);
    sendRouteError(res, err, 'Pretraga i generisanje plana nisu uspeli');
  }
});

export default router;
