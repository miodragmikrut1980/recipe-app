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
    const savedRecipes = await listRecipes(req.user.id);
    if (savedRecipes.length === 0) {
      return res.json({ matches: [] });
    }
    const matches = await suggestRecipesFromIngredients(availableIngredients, savedRecipes);
    res.json({ matches });
  } catch (err) {
    console.error('Greska pri predlaganju recepata:', err);
    res.status(500).json({ error: err.message });
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
    const savedRecipes = await listRecipes(req.user.id);
    const original = savedRecipes.find((r) => r.id === recipeId);
    if (!original) {
      return res.status(404).json({ error: 'Recept nije pronadjen' });
    }
    const customized = await customizeRecipe(original, instruction);
    const saved = await saveRecipe(customized, req.user.id);
    res.json({ recipe: saved });
  } catch (err) {
    console.error('Greska pri prilagodjavanju recepta:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Generisanje nedeljnog plana — POST { constraints?, days? }
 * Odmah upisuje generisan plan u meal_plan tabelu.
 */
router.post('/meal-plan/generate', async (req, res) => {
  const { constraints, days = 7, favoritesOnly = false } = req.body;
  try {
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

    const plan = await generateWeeklyMealPlan(savedRecipes, constraints, days);

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
    res.status(500).json({ error: err.message });
  }
});

/**
 * Kad korisnik nema (dovoljno) sacuvanih recepata: pretrazi internet za
 * dobro ocenjene recepte, sacuvaj ih kao prave recepte u kolekciji, i
 * odmah sastavi plan za trazeni broj dana (rucak + vecera svaki dan).
 */
router.post('/meal-plan/generate-online', async (req, res) => {
  const { constraints, days = 7 } = req.body;
  try {
    const neededCount = Math.min(days * 2, 10); // rucak+vecera po danu, max 10
    const foundRecipes = await findRecipesOnline(constraints, neededCount);

    if (foundRecipes.length === 0) {
      return res.status(422).json({
        error: 'Nisam pronašao odgovarajuće recepte na internetu. Probaj drugačija ograničenja.',
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

    for (let d = 0; d < days; d++) {
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
