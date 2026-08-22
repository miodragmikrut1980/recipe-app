import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp } from '../src/services/safeRemoteFetch.js';
import { dateValue, httpUrl, integerValue, normalizeAiRecipe, validateRecipePatch } from '../src/lib/validation.js';
import { aggregateIngredients } from '../src/lib/shoppingList.js';

test('SSRF zaštita blokira privatne i metadata IPv4 adrese', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('1.1.1.1'), false);
});

test('SSRF zaštita blokira privatne IPv6 adrese', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:a00:1']) assert.equal(isBlockedIp(ip), true, ip);
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
});

test('URL validator dozvoljava samo http/https bez kredencijala', () => {
  assert.equal(httpUrl('https://example.com/recept'), 'https://example.com/recept');
  assert.throws(() => httpUrl('file:///etc/passwd'));
  assert.throws(() => httpUrl('https://user:pass@example.com'));
});

test('ograničenja dana i datuma odbijaju zloupotrebu', () => {
  assert.equal(integerValue(7, 'days', { min: 1, max: 14 }), 7);
  assert.throws(() => integerValue(10000, 'days', { min: 1, max: 14 }));
  assert.equal(dateValue('2026-08-21', 'date'), '2026-08-21');
  assert.throws(() => dateValue('21.08.2026', 'date'));
});

test('recipe patch odbija neočekivana polja i prevelike vrednosti', () => {
  assert.deepEqual(validateRecipePatch({ title: 'Palačinke', servings: 4 }), { title: 'Palačinke', servings: 4 });
  assert.throws(() => validateRecipePatch({ user_id: 'attacker' }));
  assert.throws(() => validateRecipePatch({ title: 'x'.repeat(201) }));
});

test('AI recept mora sadržati upotrebljive korake ili sastojke', () => {
  assert.throws(() => normalizeAiRecipe({ title: 'Prazno', ingredients: [], steps: [] }));
  const parsed = normalizeAiRecipe({
    title: 'Supa', servings: 2, ingredients: [{ name: 'voda', amount: '1 l' }], steps: ['Skuvaj'], tags: [],
    nutritionPerServing: { calories: -5, proteinGrams: '3' },
  });
  assert.equal(parsed.nutritionPerServing.calories, 0);
  assert.equal(parsed.nutritionPerServing.proteinGrams, 3);
});

test('lista za kupovinu spaja identične sastojke i čuva izvore', () => {
  const items = aggregateIngredients([
    { title: 'A', ingredients: [{ name: ' Brašno ', amount: '200 g' }] },
    { title: 'B', ingredients: [{ name: 'brašno', amount: '200 g' }] },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].recipeTitles, ['A', 'B']);
});
