import { Router } from 'express';
import { listRecipes, saveRecipe } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { findRecipesOnline } from '../services/webRecipeSearch.js';
import { getMyRatings } from '../services/ratings.js';
import {
  suggestRecipesFromIngredients,
  customizeRecipe,
  generateWeeklyMealPlan,
} from '../services/smartFeatures.js';
import { integerValue, stringArray, stringValue, uuidValue } from '../lib/validation.js';
import { sendRouteError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { beginOperation, abandonOperation } from '../services/idempotency.js';
import { buildPlanEntries, saveGeneratedRecipesAndPlan, upsertMealPlanEntries } from '../services/transactionalPlan.js';
import { claimAiBudget } from '../services/aiBudget.js';
import { recordHouseholdActivity, requireHouseholdAdult } from '../services/householdAccess.js';

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
    logger.error('recipe_suggestion_failed', err, { requestId: req.requestId });
    sendRouteError(res, err, 'Predlaganje recepata nije uspelo', req.requestId);
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
    await recordHouseholdActivity(req.user.id, { action: 'recipe_added', entityType: 'recipe', entityId: saved.id, summary: `Dodata prilagođena verzija: ${saved.title}` });
    res.json({ recipe: saved });
  } catch (err) {
    logger.error('recipe_customization_failed', err, { requestId: req.requestId });
    sendRouteError(res, err, 'Prilagođavanje recepta nije uspelo', req.requestId);
  }
});

/**
 * Generisanje nedeljnog plana — POST { constraints?, days? }
 * Odmah upisuje generisan plan u meal_plan tabelu.
 */
router.post('/meal-plan/generate', requireHouseholdAdult, async (req, res) => {
  const { constraints, days = 7, favoritesOnly = false } = req.body;
  const operation = 'meal-plan-generate';
  let idempotency;
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

    idempotency = await beginOperation(req.user.id, operation, req.headers['idempotency-key']);
    if (idempotency.cached) return res.json(idempotency.response);
    await claimAiBudget(req.user.id, 3);

    const plan = await generateWeeklyMealPlan(savedRecipes, validConstraints, validDays);

    if (plan.length === 0) {
      await abandonOperation(req.user.id, operation, idempotency.key);
      return res.status(422).json({
        error: 'Nijedan sačuvan recept ne odgovara ovim ograničenjima. Probaj šira ograničenja ili sačuvaj još recepata.',
      });
    }

    const entries = buildPlanEntries(plan, new Date(), savedRecipes.map((recipe) => recipe.id));
    const writtenEntries = await upsertMealPlanEntries(entries, req.user.id, { operation, key: idempotency.key });
    const response = { entries: writtenEntries };
    await recordHouseholdActivity(req.user.id, { action: 'meal_planned', entityType: 'meal_plan', summary: `AI plan je napravljen · ${writtenEntries.length} obroka` });
    res.json(response);
  } catch (err) {
    await abandonOperation(req.user.id, operation, idempotency?.key).catch(() => {});
    logger.error('meal_plan_generation_failed', err, { requestId: req.requestId });
    sendRouteError(res, err, 'Generisanje plana nije uspelo', req.requestId);
  }
});

/**
 * Kad korisnik nema (dovoljno) sacuvanih recepata: pretrazi internet za
 * dobro ocenjene recepte, sacuvaj ih kao prave recepte u kolekciji, i
 * odmah sastavi plan za trazeni broj dana (rucak + vecera svaki dan).
 */
router.post('/meal-plan/generate-online', requireHouseholdAdult, async (req, res) => {
  const { constraints, days = 7, topRatedOnly = false } = req.body;
  const operation = 'meal-plan-generate-online';
  let idempotency;
  try {
    const validDays = integerValue(days, 'days', { min: 1, max: 14, defaultValue: 7 });
    const validConstraints = constraints == null ? undefined : stringValue(constraints, 'constraints', { required: false, max: 2000 });
    idempotency = await beginOperation(req.user.id, operation, req.headers['idempotency-key']);
    if (idempotency.cached) return res.json(idempotency.response);
    await claimAiBudget(req.user.id, 6);
    const neededCount = Math.min(validDays * 2, 10); // rucak+vecera po danu, max 10
    const foundRecipes = await findRecipesOnline(validConstraints, neededCount, Boolean(topRatedOnly));

    if (foundRecipes.length === 0) {
      await abandonOperation(req.user.id, operation, idempotency.key);
      return res.status(422).json({
        error: topRatedOnly
          ? 'Nisam pronašao dovoljno vrhunski ocenjenih recepata za ova ograničenja. Probaj šira ograničenja.'
          : 'Nisam pronašao odgovarajuće recepte na internetu. Probaj drugačija ograničenja.',
      });
    }

    const mealTypes = ['lunch', 'dinner'];
    const plan = [];
    let idx = 0;

    for (let d = 0; d < validDays; d++) {
      for (const mealType of mealTypes) {
        const recipe = foundRecipes[idx % foundRecipes.length];
        idx++;
        plan.push({ dayOffset: d, mealType, recipeId: recipe.id });
      }
    }
    const entries = buildPlanEntries(plan, new Date(), foundRecipes.map((recipe) => recipe.id));
    const saved = await saveGeneratedRecipesAndPlan(foundRecipes, entries, req.user.id, { operation, key: idempotency.key });
    const response = { entries: saved.entries || [], recipesFound: (saved.recipes || []).length };
    await recordHouseholdActivity(req.user.id, { action: 'meal_planned', entityType: 'meal_plan', summary: `Online plan je napravljen · ${response.entries.length} obroka` });
    res.json(response);
  } catch (err) {
    await abandonOperation(req.user.id, operation, idempotency?.key).catch(() => {});
    logger.error('online_meal_plan_failed', err, { requestId: req.requestId });
    sendRouteError(res, err, 'Pretraga i generisanje plana nisu uspeli', req.requestId);
  }
});

export default router;
