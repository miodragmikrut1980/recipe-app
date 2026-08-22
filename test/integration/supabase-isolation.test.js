import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const REQUIRED = ['TEST_API_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY'];
for (const name of REQUIRED) {
  if (!process.env[name]) throw new Error(`Nedostaje ${name} za integracione testove`);
}

const apiUrl = process.env.TEST_API_URL.replace(/\/$/, '');
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const users = [];
let householdId;

async function createActor(label) {
  const email = `integration-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = `Test-${randomUUID()}-A1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const { data: session, error: loginError } = await anon.auth.signInWithPassword({ email, password });
  if (loginError) throw loginError;
  return { id: data.user.id, token: session.session.access_token };
}

async function api(actor, path, options = {}) {
  return fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${actor.token}`, ...(options.headers || {}) },
  });
}

async function jsonRequest(actor, path, method, body) {
  return api(actor, path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('staging izolacija, domaćinstvo, rollback, idempotency i AI budžet', async (t) => {
  const owner = await createActor('owner');
  const member = await createActor('member');
  const outsider = await createActor('outsider');

  t.after(async () => {
    if (householdId) await admin.from('households').delete().eq('id', householdId);
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });

  const health = await fetch(`${apiUrl}/health`);
  assert.equal(health.status, 200);
  const ready = await fetch(`${apiUrl}/ready`);
  assert.equal(ready.status, 200, await ready.text());

  const { data: household, error: householdError } = await admin.rpc('create_household_for_user', {
    p_user_id: owner.id,
    p_name: 'Integration domaćinstvo',
  }).single();
  if (householdError) throw householdError;
  householdId = household.id;
  const { error: joinError } = await admin.rpc('join_household_for_user', {
    p_user_id: member.id,
    p_invite_code: household.invite_code,
  });
  if (joinError) throw joinError;

  const ownerRecipeId = randomUUID();
  const outsiderRecipeId = randomUUID();
  const baseRecipe = {
    source_url: 'https://example.com/integration', source_platform: 'other', servings: 2,
    ingredients: [{ name: 'brašno', amount: '200 g' }], steps: ['Pomešaj'], tags: ['test'],
  };
  const { error: recipeError } = await admin.from('recipes').insert([
    { ...baseRecipe, id: ownerRecipeId, user_id: owner.id, household_id: householdId, title: 'Porodični recept' },
    { ...baseRecipe, id: outsiderRecipeId, user_id: outsider.id, household_id: null, title: 'Privatni recept' },
  ]);
  if (recipeError) throw recipeError;

  const outsiderList = await api(outsider, '/recipes');
  const outsiderRecipes = (await outsiderList.json()).recipes;
  assert.equal(outsiderRecipes.some((recipe) => recipe.id === ownerRecipeId), false);

  const memberList = await api(member, '/recipes');
  const memberRecipes = (await memberList.json()).recipes;
  assert.equal(memberRecipes.some((recipe) => recipe.id === ownerRecipeId), true);

  for (const actor of [outsider, member]) {
    const update = await jsonRequest(actor, `/recipes/${ownerRecipeId}`, 'PUT', { title: 'Napad' });
    assert.equal(update.status, 404, `tuđ update mora biti 404, dobijeno ${update.status}`);
    const remove = await api(actor, `/recipes/${ownerRecipeId}`, { method: 'DELETE' });
    assert.equal(remove.status, 404, `tuđ delete mora biti 404, dobijeno ${remove.status}`);
  }

  const outsiderPlan = await jsonRequest(outsider, '/meal-plan', 'PUT', {
    date: '2099-01-10', mealType: 'lunch', recipeId: ownerRecipeId,
  });
  assert.equal(outsiderPlan.status, 404);
  const outsiderShopping = await jsonRequest(outsider, '/shopping-list/generate', 'POST', { recipeIds: [ownerRecipeId] });
  assert.equal(outsiderShopping.status, 404);
  const outsiderRating = await jsonRequest(outsider, `/recipes/${ownerRecipeId}/rating`, 'PUT', { rating: 5 });
  assert.equal(outsiderRating.status, 404);

  const memberPlan = await jsonRequest(member, '/meal-plan', 'PUT', {
    date: '2099-01-10', mealType: 'lunch', recipeId: ownerRecipeId,
  });
  assert.equal(memberPlan.status, 200, await memberPlan.text());
  const memberShopping = await jsonRequest(member, '/shopping-list/generate', 'POST', { recipeIds: [ownerRecipeId] });
  assert.equal(memberShopping.status, 200, await memberShopping.text());
  const memberRating = await jsonRequest(member, `/recipes/${ownerRecipeId}/rating`, 'PUT', { rating: 5 });
  assert.equal(memberRating.status, 200, await memberRating.text());

  const pantryCreate = await jsonRequest(owner, '/pantry', 'POST', {
    name: 'brašno', quantity: 750, unit: 'g', category: 'Pekara i ostava', location: 'Ostava', expiresOn: '2099-12-31',
  });
  assert.equal(pantryCreate.status, 201, await pantryCreate.text());
  const memberPantry = await api(member, '/pantry');
  assert.equal(memberPantry.status, 200);
  assert.equal((await memberPantry.json()).items.some((item) => item.name === 'brašno'), true);
  const outsiderPantry = await api(outsider, '/pantry');
  assert.equal((await outsiderPantry.json()).items.length, 0);

  const pantryAwareShopping = await jsonRequest(member, '/shopping-list/generate', 'POST', { recipeIds: [ownerRecipeId] });
  assert.equal(pantryAwareShopping.status, 200);
  assert.equal((await pantryAwareShopping.json()).items.length, 0, '750 g u ostavi pokriva potrebnih 200 g');

  const previewConsumption = await jsonRequest(member, '/pantry/consume-recipe', 'POST', { recipeId: ownerRecipeId, commit: false });
  assert.equal(previewConsumption.status, 200, await previewConsumption.text());
  assert.equal((await previewConsumption.json()).changes[0].after, 550);
  const commitConsumption = await jsonRequest(member, '/pantry/consume-recipe', 'POST', { recipeId: ownerRecipeId, commit: true });
  assert.equal(commitConsumption.status, 200, await commitConsumption.text());
  const pantryAfterCooking = await api(owner, '/pantry');
  assert.equal((await pantryAfterCooking.json()).items[0].quantity, 550);

  const childRole = await jsonRequest(owner, `/household/members/${member.id}/role`, 'PUT', { role: 'child' });
  assert.equal(childRole.status, 200, await childRole.text());
  const childPantryMutation = await jsonRequest(member, '/pantry', 'POST', { name: 'zabranjeno', quantity: 1, unit: 'kom', category: 'Ostalo', location: 'Ostava' });
  assert.equal(childPantryMutation.status, 403);
  const childShoppingMutation = await jsonRequest(member, '/shopping-list', 'PUT', { baseRevision: 0, items: [] });
  assert.equal(childShoppingMutation.status, 403);
  const outsiderRole = await jsonRequest(outsider, `/household/members/${member.id}/role`, 'PUT', { role: 'adult' });
  assert.equal(outsiderRole.status, 403);
  const adultRole = await jsonRequest(owner, `/household/members/${member.id}/role`, 'PUT', { role: 'adult' });
  assert.equal(adultRole.status, 200, await adultRole.text());
  const activity = await api(member, '/household/activity');
  assert.equal(activity.status, 200);
  assert.equal((await activity.json()).activities.some((entry) => entry.action === 'member_role_changed'), true);

  const memberFavorite = await jsonRequest(member, `/recipes/${ownerRecipeId}/favorite`, 'PUT', { favorite: true });
  assert.equal(memberFavorite.status, 200, await memberFavorite.text());
  const favorites = await api(member, '/favorites');
  assert.deepEqual((await favorites.json()).recipeIds, [ownerRecipeId]);
  const outsiderFavorite = await jsonRequest(outsider, `/recipes/${ownerRecipeId}/favorite`, 'PUT', { favorite: true });
  assert.equal(outsiderFavorite.status, 404);

  const firstShoppingSave = await jsonRequest(owner, '/shopping-list', 'PUT', {
    baseRevision: 0, items: [{ name: 'jabuke', amount: '1 kg', recipeTitle: 'Ručno', checked: false }],
  });
  const firstState = await firstShoppingSave.json();
  assert.equal(firstShoppingSave.status, 200, JSON.stringify(firstState));
  const memberSharedList = await api(member, '/shopping-list');
  const memberSharedState = await memberSharedList.json();
  assert.equal(memberSharedState.items[0].name, 'jabuke');
  const secondShoppingSave = await jsonRequest(member, '/shopping-list', 'PUT', {
    baseRevision: memberSharedState.revision, items: [{ ...memberSharedState.items[0], checked: true }],
  });
  assert.equal(secondShoppingSave.status, 200, await secondShoppingSave.text());
  const staleSave = await jsonRequest(owner, '/shopping-list', 'PUT', {
    baseRevision: firstState.revision, items: [{ name: 'pregazi', amount: '', recipeTitle: 'Napad', checked: false }],
  });
  assert.equal(staleSave.status, 409, 'zastarela revizija ne sme prepisati noviju porodičnu listu');

  const rollbackDate = '2099-01-11';
  const { error: rollbackError } = await admin.rpc('upsert_meal_plan_entries', {
    p_user_id: outsider.id,
    p_entries: [
      { date: rollbackDate, mealType: 'breakfast', recipeId: outsiderRecipeId },
      { date: rollbackDate, mealType: 'dinner', recipeId: randomUUID() },
    ],
    p_operation: null,
    p_key: null,
  });
  assert.match(rollbackError?.message || '', /RECIPE_NOT_ACCESSIBLE/);
  const { data: rolledBackRows } = await admin.from('meal_plan').select('id')
    .eq('user_id', outsider.id).eq('date', rollbackDate);
  assert.equal(rolledBackRows.length, 0, 'prvi upis mora biti vraćen kada drugi padne');

  const operation = 'integration-idempotency';
  const key = `integration:${randomUUID()}`;
  const { data: firstClaim, error: firstClaimError } = await admin.rpc('claim_idempotency_key', {
    p_user_id: outsider.id, p_operation: operation, p_key: key,
  });
  if (firstClaimError) throw firstClaimError;
  assert.equal(firstClaim.state, 'started');
  const { error: atomicError } = await admin.rpc('upsert_meal_plan_entries', {
    p_user_id: outsider.id,
    p_entries: [{ date: '2099-01-12', mealType: 'dinner', recipeId: outsiderRecipeId }],
    p_operation: operation,
    p_key: key,
  });
  if (atomicError) throw atomicError;
  const { data: secondClaim, error: secondClaimError } = await admin.rpc('claim_idempotency_key', {
    p_user_id: outsider.id, p_operation: operation, p_key: key,
  });
  if (secondClaimError) throw secondClaimError;
  assert.equal(secondClaim.state, 'completed');
  assert.equal(secondClaim.response.entries.length, 1);

  const transfer = await jsonRequest(owner, '/household/transfer', 'POST', { memberId: member.id });
  assert.equal(transfer.status, 200, await transfer.text());
  const formerOwnerChange = await jsonRequest(owner, `/household/members/${member.id}/role`, 'PUT', { role: 'adult' });
  assert.equal(formerOwnerChange.status, 403);

  const { data: usage, error: usageError } = await admin.rpc('claim_ai_budget', {
    p_user_id: outsider.id, p_cost: 2, p_user_limit: 2, p_global_limit: 1000000000,
  });
  if (usageError) throw usageError;
  assert.equal(usage.userCredits, 2);
  const { error: limitError } = await admin.rpc('claim_ai_budget', {
    p_user_id: outsider.id, p_cost: 1, p_user_limit: 2, p_global_limit: 1000000000,
  });
  assert.match(limitError?.message || '', /AI_DAILY_USER_LIMIT/);
});
