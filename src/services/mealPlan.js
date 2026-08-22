import { createClient } from '@supabase/supabase-js';
import { getAccessibleRecipe } from './db.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function setMealPlanEntry({ date, mealType, recipeId }, userId) {
  await getAccessibleRecipe(recipeId, userId);
  const { data, error } = await supabase
    .from('meal_plan')
    .upsert(
      { user_id: userId, date, meal_type: mealType, recipe_id: recipeId },
      { onConflict: 'user_id,date,meal_type' }
    )
    .select()
    .single();
  if (error) throw new Error(`Cuvanje meal plana nije uspelo: ${error.message}`);
  return data;
}

export async function removeMealPlanEntry({ date, mealType }, userId) {
  const { error } = await supabase
    .from('meal_plan')
    .delete()
    .eq('user_id', userId)
    .eq('date', date)
    .eq('meal_type', mealType);
  if (error) throw new Error(`Brisanje meal plan stavke nije uspelo: ${error.message}`);
}

export async function getMealPlanRange(startDate, endDate, userId) {
  const { data, error } = await supabase
    .from('meal_plan')
    .select('date, meal_type, recipe_id, recipes(title, thumbnail_url)')
    .eq('user_id', userId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (error) throw new Error(`Ucitavanje meal plana nije uspelo: ${error.message}`);
  return data;
}
