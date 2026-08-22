import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeIngredientName, pantryContainsIngredient, subtractPantryFromShopping } from '../src/lib/ingredientName.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('nazivi namirnica se normalizuju za srpski jezik', () => {
  assert.equal(normalizeIngredientName('  Sveža Šargarepa! '), 'sargarepa');
  assert.equal(normalizeIngredientName('Mlevena paprika'), 'paprika');
  assert.equal(pantryContainsIngredient('crni luk', 'sitno seckan crni luk'), true);
  assert.equal(pantryContainsIngredient('pirinač', 'testenina'), false);
  assert.equal(pantryContainsIngredient('so', 'losos'), false);
});

test('ostava oduzima raspoloživu količinu i ostavlja samo ono što nedostaje', () => {
  const items = [
    { name: 'brašno', amount: '2 kg', checked: false },
    { name: 'mleko', amount: '1 l', checked: false },
  ];
  const pantry = [
    { name: 'brašno', quantity: 750, unit: 'g' },
    { name: 'mleko', quantity: 2, unit: 'l' },
  ];
  assert.deepEqual(subtractPantryFromShopping(items, pantry), [{ name: 'brašno', amount: '1.25 kg', checked: false }]);
});

test('v1.4 migracija izoluje porodične podatke i real-time listu', () => {
  const sql = read('migrations/20260822_competitive_features.sql');
  assert.match(sql, /create table if not exists public\.pantry_items/);
  assert.match(sql, /create table if not exists public\.recipe_favorites/);
  assert.match(sql, /create table if not exists public\.shared_shopping_lists/);
  assert.match(sql, /household_id in \(select household_id from public\.profiles where id = auth\.uid\(\)\)/);
  assert.match(sql, /alter publication supabase_realtime add table public\.shared_shopping_lists/);
  assert.match(sql, /grant select on public\.shared_shopping_lists to authenticated/);
  assert.match(sql, /from public\.shopping_lists s/);
  assert.match(sql, /revoke all on public\.pantry_items, public\.recipe_favorites, public\.market_offers from public, anon, authenticated/);
});

test('kupovina proverava ostavu, a favoriti proveravaju pristup receptu', () => {
  assert.match(read('src/services/shoppingList.js'), /subtractPantryFromShopping/);
  assert.match(read('src/services/favorites.js'), /getAccessibleRecipe\(recipeId, userId\)/);
  assert.match(read('src/services/pantry.js'), /scopeFor\(userId\)/);
  assert.match(read('src/services/shoppingList.js'), /baseRevision/);
  assert.match(read('src/services/shoppingList.js'), /new HttpError\(409/);
});

test('market API je read-only za mobilnog korisnika', () => {
  assert.match(read('src/routes/marketOffers.js'), /router\.post\('\/market-offers\/search', requireAuth/);
  assert.doesNotMatch(read('src/routes/marketOffers.js'), /router\.(put|delete|patch)/);
  assert.match(read('scripts/import-market-offers.js'), /sourceUrl\.startsWith\('https:\/\/'\)/);
  assert.match(read('scripts/import-market-offers.js'), /rows\.length; offset \+= 500/);
});
