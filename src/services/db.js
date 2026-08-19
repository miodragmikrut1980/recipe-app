import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Backend koristi service_role kljuc, pa RLS ne vazi ovde — zato SVAKA
 * funkcija eksplicitno filtrira po userId. Nikad ne pozivaj ove funkcije
 * bez userId iz verifikovanog tokena (vidi middleware/auth.js).
 */

export async function saveRecipe(recipe, userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('household_id')
    .eq('id', userId)
    .maybeSingle();

  const { data, error } = await supabase
    .from('recipes')
    .insert({
      id: recipe.id,
      user_id: userId,
      household_id: profile?.household_id || null,
      title: recipe.title,
      source_url: recipe.sourceUrl,
      source_platform: recipe.sourcePlatform,
      thumbnail_url: recipe.thumbnailUrl || null,
      servings: recipe.servings || null,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      prep_time_minutes: recipe.prepTimeMinutes || null,
      tags: recipe.tags,
      nutrition_per_serving: recipe.nutritionPerServing || null,
      created_at: recipe.createdAt,
    })
    .select()
    .single();

  if (error) throw new Error(`Cuvanje u bazu nije uspelo: ${error.message}`);
  return mapRowToRecipe(data);
}

export async function listRecipes(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('household_id')
    .eq('id', userId)
    .maybeSingle();

  let query = supabase.from('recipes').select('*').order('created_at', { ascending: false });

  if (profile?.household_id) {
    query = query.or(`user_id.eq.${userId},household_id.eq.${profile.household_id}`);
  } else {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Ucitavanje recepata nije uspelo: ${error.message}`);
  return data.map(mapRowToRecipe);
}

export async function deleteRecipe(id, userId) {
  const { error } = await supabase.from('recipes').delete().eq('id', id).eq('user_id', userId);
  if (error) throw new Error(`Brisanje recepta nije uspelo: ${error.message}`);
}

function mapRowToRecipe(row) {
  return {
    id: row.id,
    ownerId: row.user_id,
    title: row.title,
    sourceUrl: row.source_url,
    sourcePlatform: row.source_platform,
    thumbnailUrl: row.thumbnail_url,
    servings: row.servings,
    ingredients: row.ingredients,
    steps: row.steps,
    prepTimeMinutes: row.prep_time_minutes,
    tags: row.tags,
    nutritionPerServing: row.nutrition_per_serving,
    createdAt: row.created_at,
  };
}
