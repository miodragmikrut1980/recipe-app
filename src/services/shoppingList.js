import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function generateShoppingList(recipeIds, userId) {
  const { data: recipes, error } = await supabase
    .from('recipes')
    .select('id, title, ingredients')
    .in('id', recipeIds);
  if (error) throw new Error(`Ucitavanje recepata za listu nije uspelo: ${error.message}`);

  const items = [];
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients || []) {
      items.push({
        name: ingredient.name,
        amount: ingredient.amount || '',
        recipeTitle: recipe.title,
        checked: false,
      });
    }
  }
  return items;
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
