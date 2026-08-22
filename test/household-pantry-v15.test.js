import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPantryConsumption } from '../src/lib/ingredientName.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('potrošnja ostave koristi kompatibilne jedinice i nikad ne ide ispod nule', () => {
  assert.deepEqual(buildPantryConsumption([{ name: 'brašno', amount: '0.5 kg' }, { name: 'mleko', amount: '2 l' }], [
    { id: 'a', name: 'Brašno', quantity: 750, unit: 'g' },
    { id: 'b', name: 'Mleko', quantity: 1, unit: 'l' },
  ]), [
    { id: 'a', name: 'Brašno', deduction: 500, unit: 'g', before: 750, after: 250 },
    { id: 'b', name: 'Mleko', deduction: 1, unit: 'l', before: 1, after: 0 },
  ]);
});

test('nepoznata količina se ne oduzima automatski', () => {
  assert.deepEqual(buildPantryConsumption([{ name: 'so', amount: 'po ukusu' }], [{ id: 'a', name: 'So', quantity: 1, unit: 'kg' }]), []);
});

test('v1.5 RPC zaključava uloge i potrošnju na service role', () => {
  const sql = read('migrations/20260822_household_lifecycle.sql');
  assert.match(sql, /set_household_member_role/);
  assert.match(sql, /transfer_household_ownership/);
  assert.match(sql, /OWNER_TRANSFER_REQUIRED/);
  assert.match(sql, /consume_pantry_items/);
  assert.match(sql, /jsonb_array_length\(p_changes\) > 100/);
  assert.match(sql, /revoke all on function public\.consume_pantry_items\(uuid,jsonb\) from public,anon,authenticated/);
});

test('rute validiraju UUID i server ponovo računa potrošnju', () => {
  const household = read('src/routes/household.js');
  const pantryRoute = read('src/routes/pantry.js');
  const pantryService = read('src/services/pantry.js');
  assert.match(household, /uuidValue\(req\.params\.id, 'id'\)/);
  assert.match(household, /uuidValue\(req\.body\.memberId, 'memberId'\)/);
  assert.match(pantryRoute, /uuidValue\(req\.body\?\.recipeId, 'recipeId'\)/);
  assert.match(pantryService, /getAccessibleRecipe\(recipeId, userId\)/);
  assert.match(pantryService, /buildPantryConsumption\(recipe\.ingredients, pantry\)/);
});
