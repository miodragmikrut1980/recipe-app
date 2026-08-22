import { createClient } from '@supabase/supabase-js';
import { getAccessibleRecipesByIds } from './db.js';
import { aggregateIngredients } from '../lib/shoppingList.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function generateShoppingList(recipeIds, userId) {
  const recipes = await getAccessibleRecipesByIds(recipeIds, userId);

  return aggregateIngredients(recipes);
}

export async function saveShoppingListState(items, userId) {
  const { error } = await supabase
    .from('shopping_lists')
    .upsert({ user_id: userId, items, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Cuvanje liste za kupovinu nije uspelo: ${error.message}`);
}

export async function loadShoppingListState(userId) {
  const { data, error } = await supabase
    .from('shopping_lists')
    .select('items')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`Ucitavanje liste za kupovinu nije uspelo: ${error.message}`);
  return data?.items || [];
}
