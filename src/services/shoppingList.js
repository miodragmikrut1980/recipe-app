import { createClient } from '@supabase/supabase-js';
import { getAccessibleRecipesByIds } from './db.js';
import { aggregateIngredients } from '../lib/shoppingList.js';
import { subtractPantryFromShopping } from '../lib/ingredientName.js';
import { HttpError } from '../lib/httpError.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function generateShoppingList(recipeIds, userId) {
  const recipes = await getAccessibleRecipesByIds(recipeIds, userId);
  const generated = aggregateIngredients(recipes);
  const scope = await shoppingScope(userId);
  let pantryQuery = supabase.from('pantry_items').select('name,quantity,unit').gt('quantity', 0);
  pantryQuery = scope.type === 'household' ? pantryQuery.eq('household_id', scope.id) : pantryQuery.eq('user_id', userId).is('household_id', null);
  const { data: pantry, error } = await pantryQuery;
  if (error) throw new Error(`Učitavanje ostave nije uspelo: ${error.message}`);
  return subtractPantryFromShopping(generated, pantry);
}

async function shoppingScope(userId) {
  const { data, error } = await supabase.from('profiles').select('household_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`Učitavanje profila nije uspelo: ${error.message}`);
  return data?.household_id ? { type: 'household', id: data.household_id } : { type: 'user', id: userId };
}

export async function saveShoppingListState(items, userId, baseRevision = null) {
  const scope = await shoppingScope(userId);
  const row = scope.type === 'household'
    ? { scope_id: scope.id, household_id: scope.id, owner_user_id: null, items, updated_at: new Date().toISOString() }
    : { scope_id: scope.id, household_id: null, owner_user_id: userId, items, updated_at: new Date().toISOString() };
  const { data: current, error: currentError } = await supabase.from('shared_shopping_lists').select('revision').eq('scope_id', scope.id).maybeSingle();
  if (currentError) throw new Error(`Učitavanje liste za kupovinu nije uspelo: ${currentError.message}`);
  if (Number.isInteger(baseRevision) && (current?.revision || 0) !== baseRevision) throw new HttpError(409, 'Lista je promenjena na drugom uređaju. Osveži je pre ponovnog čuvanja.');
  const request = current
    ? supabase.from('shared_shopping_lists').update(row).eq('scope_id', scope.id).eq('revision', current.revision)
    : supabase.from('shared_shopping_lists').insert(row);
  const { data, error } = await request.select('revision').maybeSingle();
  if (error) throw new Error(`Cuvanje liste za kupovinu nije uspelo: ${error.message}`);
  if (!data) throw new HttpError(409, 'Lista je promenjena na drugom uređaju. Osveži je pre ponovnog čuvanja.');
  return { scopeType: scope.type, scopeId: scope.id, revision: data.revision };
}

export async function loadShoppingListState(userId) {
  const scope = await shoppingScope(userId);
  const { data, error } = await supabase.from('shared_shopping_lists').select('items,revision').eq('scope_id', scope.id).maybeSingle();
  if (error) throw new Error(`Ucitavanje liste za kupovinu nije uspelo: ${error.message}`);
  return { items: data?.items || [], scopeType: scope.type, scopeId: scope.id, revision: data?.revision || 0 };
}
