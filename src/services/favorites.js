import { createClient } from '@supabase/supabase-js';
import { getAccessibleRecipe } from './db.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function listFavorites(userId) {
  const { data, error } = await supabase.from('recipe_favorites').select('recipe_id').eq('user_id', userId);
  if (error) throw new Error(`Učitavanje favorita nije uspelo: ${error.message}`);
  return data.map((row) => row.recipe_id);
}

export async function setFavorite(recipeId, userId, favorite) {
  await getAccessibleRecipe(recipeId, userId);
  if (favorite) {
    const { error } = await supabase.from('recipe_favorites').upsert({ recipe_id: recipeId, user_id: userId }, { onConflict: 'user_id,recipe_id' });
    if (error) throw new Error(`Čuvanje favorita nije uspelo: ${error.message}`);
  } else {
    const { error } = await supabase.from('recipe_favorites').delete().eq('recipe_id', recipeId).eq('user_id', userId);
    if (error) throw new Error(`Brisanje favorita nije uspelo: ${error.message}`);
  }
}
