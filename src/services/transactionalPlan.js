import { createClient } from '@supabase/supabase-js';
export { buildPlanEntries } from '../lib/planEntries.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function upsertMealPlanEntries(entries, userId, idempotency = {}) {
  const { data, error } = await supabase.rpc('upsert_meal_plan_entries', {
    p_user_id: userId,
    p_entries: entries,
    p_operation: idempotency.operation || null,
    p_key: idempotency.key || null,
  });
  if (error) throw new Error(`Atomsko čuvanje plana nije uspelo: ${error.message}`);
  return data || [];
}

export async function saveGeneratedRecipesAndPlan(recipes, entries, userId, idempotency = {}) {
  const payload = recipes.map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    source_url: recipe.sourceUrl,
    source_platform: recipe.sourcePlatform,
    thumbnail_url: recipe.thumbnailUrl || null,
    servings: recipe.servings ?? null,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    prep_time_minutes: recipe.prepTimeMinutes ?? null,
    tags: recipe.tags,
    nutrition_per_serving: recipe.nutritionPerServing ?? null,
    created_at: recipe.createdAt,
  }));
  const { data, error } = await supabase.rpc('save_generated_recipes_and_plan', {
    p_user_id: userId,
    p_recipes: payload,
    p_entries: entries,
    p_operation: idempotency.operation || null,
    p_key: idempotency.key || null,
  });
  if (error) throw new Error(`Atomsko čuvanje online plana nije uspelo: ${error.message}`);
  return data;
}
