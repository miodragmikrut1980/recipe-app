import { createClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/httpError.js';
import { buildPantryConsumption, normalizeIngredientName } from '../lib/ingredientName.js';
import { getAccessibleRecipe } from './db.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function scopeFor(userId) {
  const { data, error } = await supabase.from('profiles').select('household_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`Učitavanje profila nije uspelo: ${error.message}`);
  return data?.household_id ? { householdId: data.household_id } : { userId };
}

function scoped(query, scope) {
  return scope.householdId ? query.eq('household_id', scope.householdId) : query.eq('user_id', scope.userId).is('household_id', null);
}

function mapItem(row) {
  return { id: row.id, name: row.name, quantity: Number(row.quantity), unit: row.unit, category: row.category, location: row.location, expiresOn: row.expires_on, updatedAt: row.updated_at };
}

export async function listPantry(userId) {
  const scope = await scopeFor(userId);
  const { data, error } = await scoped(supabase.from('pantry_items').select('*').order('expires_on', { ascending: true, nullsFirst: false }), scope);
  if (error) throw new Error(`Učitavanje ostave nije uspelo: ${error.message}`);
  return data.map(mapItem);
}

export async function addPantryItem(userId, item) {
  const scope = await scopeFor(userId);
  const row = {
    user_id: userId,
    household_id: scope.householdId || null,
    name: item.name,
    normalized_name: normalizeIngredientName(item.name),
    quantity: item.quantity,
    unit: item.unit,
    category: item.category,
    location: item.location,
    expires_on: item.expiresOn || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('pantry_items').insert(row).select().single();
  if (error) throw new Error(`Dodavanje u ostavu nije uspelo: ${error.message}`);
  return mapItem(data);
}

export async function updatePantryItem(userId, id, item) {
  const scope = await scopeFor(userId);
  const row = { ...item, ...(item.name ? { normalized_name: normalizeIngredientName(item.name) } : {}), updated_at: new Date().toISOString() };
  delete row.expiresOn;
  if ('expiresOn' in item) row.expires_on = item.expiresOn || null;
  const { data, error } = await scoped(supabase.from('pantry_items').update(row).eq('id', id), scope).select().maybeSingle();
  if (error) throw new Error(`Izmena ostave nije uspela: ${error.message}`);
  if (!data) throw new HttpError(404, 'Namirnica nije pronađena');
  return mapItem(data);
}

export async function deletePantryItem(userId, id) {
  const scope = await scopeFor(userId);
  const { data, error } = await scoped(supabase.from('pantry_items').delete().eq('id', id), scope).select('id').maybeSingle();
  if (error) throw new Error(`Brisanje iz ostave nije uspelo: ${error.message}`);
  if (!data) throw new HttpError(404, 'Namirnica nije pronađena');
}

export async function consumeRecipeFromPantry(userId, recipeId, commit = false) {
  const [recipe, pantry] = await Promise.all([getAccessibleRecipe(recipeId, userId), listPantry(userId)]);
  const changes = buildPantryConsumption(recipe.ingredients, pantry);
  if (!commit || changes.length === 0) return changes;
  const { error } = await supabase.rpc('consume_pantry_items', { p_user_id: userId, p_changes: changes.map(({ id, deduction }) => ({ id, deduction })) });
  if (error) throw new Error(`Umanjenje ostave nije uspelo: ${error.message}`);
  return changes;
}
