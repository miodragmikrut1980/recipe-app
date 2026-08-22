import { createClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/httpError.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Backend koristi service_role kljuc, pa RLS ne vazi ovde — zato SVAKA
 * funkcija eksplicitno filtrira po userId. Nikad ne pozivaj ove funkcije
 * bez userId iz verifikovanog tokena (vidi middleware/auth.js).
 */

export async function saveRecipe(recipe, userId) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('household_id')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw new Error(`Učitavanje profila nije uspelo: ${profileError.message}`);

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

/**
 * Trazi vec sacuvan recept korisnika sa vrlo slicnim naslovom (case/space
 * neosetljivo), da bi upozorili korisnika ako je slucajno sacuvao isti
 * video/recept dvaput. Ne blokira cuvanje — samo vraca info da se prikaze
 * kao pitanje korisniku posle uspesnog cuvanja.
 */
export async function findPossibleDuplicate(title, userId, excludeId) {
  const normalized = title.trim().toLowerCase();
  const { data, error } = await supabase
    .from('recipes')
    .select('id, title')
    .eq('user_id', userId)
    .neq('id', excludeId)
    .ilike('title', normalized);

  if (error || !data || data.length === 0) return null;
  return { id: data[0].id, title: data[0].title };
}

export async function listRecipes(userId) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('household_id')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw new Error(`Učitavanje profila nije uspelo: ${profileError.message}`);

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

export async function getAccessibleRecipe(id, userId) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles').select('household_id').eq('id', userId).maybeSingle();
  if (profileError) throw new Error(`Učitavanje profila nije uspelo: ${profileError.message}`);

  let query = supabase.from('recipes').select('*').eq('id', id);
  query = profile?.household_id
    ? query.or(`user_id.eq.${userId},household_id.eq.${profile.household_id}`)
    : query.eq('user_id', userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Učitavanje recepta nije uspelo: ${error.message}`);
  if (!data) throw new HttpError(404, 'Recept nije pronađen');
  return mapRowToRecipe(data);
}

export async function getAccessibleRecipesByIds(ids, userId) {
  const uniqueIds = [...new Set(ids)];
  const { data: profile, error: profileError } = await supabase
    .from('profiles').select('household_id').eq('id', userId).maybeSingle();
  if (profileError) throw new Error(`Učitavanje profila nije uspelo: ${profileError.message}`);
  let query = supabase.from('recipes').select('*').in('id', uniqueIds);
  query = profile?.household_id
    ? query.or(`user_id.eq.${userId},household_id.eq.${profile.household_id}`)
    : query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error(`Učitavanje recepata nije uspelo: ${error.message}`);
  if (data.length !== uniqueIds.length) throw new HttpError(404, 'Jedan ili više recepata nije pronađeno');
  return data.map(mapRowToRecipe);
}

export async function updateRecipe(id, updates, userId) {
  const patch = {};
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.servings !== undefined) patch.servings = updates.servings;
  if (updates.ingredients !== undefined) patch.ingredients = updates.ingredients;
  if (updates.steps !== undefined) patch.steps = updates.steps;
  if (updates.prepTimeMinutes !== undefined) patch.prep_time_minutes = updates.prepTimeMinutes;
  if (updates.tags !== undefined) patch.tags = updates.tags;

  const { data, error } = await supabase
    .from('recipes')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId) // samo vlasnik sme da menja
    .select()
    .maybeSingle();

  if (error) throw new Error(`Izmena recepta nije uspela: ${error.message}`);
  if (!data) throw new HttpError(404, 'Recept nije pronađen ili nije u vašem vlasništvu');
  return mapRowToRecipe(data);
}

export async function deleteRecipe(id, userId) {
  const { data, error } = await supabase.from('recipes').delete().eq('id', id).eq('user_id', userId).select('id').maybeSingle();
  if (error) throw new Error(`Brisanje recepta nije uspelo: ${error.message}`);
  if (!data) throw new HttpError(404, 'Recept nije pronađen ili nije u vašem vlasništvu');
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
