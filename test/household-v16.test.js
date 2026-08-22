import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('v1.6 migracija pravi izolovanu istoriju domaćinstva', () => {
  const sql = read('migrations/20260822_household_activity.sql');
  assert.match(sql, /create table if not exists public\.household_activity/);
  assert.match(sql, /household_id in\(select household_id from public\.profiles where id=auth\.uid\(\)\)/);
  assert.match(sql, /revoke all on public\.household_activity from public,anon,authenticated/);
  assert.match(sql, /grant select,insert on public\.household_activity to service_role/);
});

test('dečji nalog dobija server-side read-only zaštitu', () => {
  const access = read('src/services/householdAccess.js');
  assert.match(access, /context\.role === 'child'/);
  assert.match(access, /new HttpError\(403/);
  assert.match(read('src/routes/pantry.js'), /requireHouseholdAdult/);
  assert.match(read('src/routes/shoppingList.js'), /router\.put\('\/shopping-list', requireHouseholdAdult/);
  assert.match(read('src/routes/mealPlan.js'), /router\.put\('\/meal-plan', requireHouseholdAdult/);
  assert.match(read('src/index.js'), /app\.put\('\/recipes\/:id', requireAuth, requireHouseholdAdult/);
});

test('aktivnosti ne ruše primarnu operaciju kada audit upis zakaže', () => {
  assert.match(read('src/services/householdAccess.js'), /household_activity_write_failed/);
  assert.match(read('src/services/householdAccess.js'), /logger\.warn/);
});

test('istorija vraća imena za prikaz bez izlaganja email adresa', () => {
  const source = read('src/services/householdAccess.js');
  assert.match(source, /select\('id,display_name'\)/);
  assert.doesNotMatch(source, /\.select\([^)]*email/);
});
