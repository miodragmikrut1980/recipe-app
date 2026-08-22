import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function jsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsFiles(path) : entry.name.endsWith('.js') ? [path] : [];
  });
}

test('produkcioni kod nema stare logove sadržaja recepta i DNS adresa', () => {
  const source = jsFiles(fileURLToPath(new URL('../src', import.meta.url))).map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(source, /RECIPE-TEXT-DEBUG|DNS-DEBUG|cleaned\.slice\(0,\s*3000\)/);
});

test('direktni console pozivi postoje samo u centralnom loggeru', () => {
  const files = jsFiles(fileURLToPath(new URL('../src', import.meta.url)));
  const offenders = files.filter((path) => !path.endsWith('/lib/logger.js') && /console\.(log|warn|error)/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('foto i video rute proveravaju magic bytes', () => {
  assert.match(read('src/routes/parsePhotoRecipe.js'), /verifyUploadedFile\(req\.file\.path, 'image'\)/);
  assert.match(read('src/routes/parseVideoRecipe.js'), /verifyUploadedFile\(req\.file\.path, 'video'\)/);
});

test('generisanje planova koristi atomske RPC operacije', () => {
  const source = read('src/routes/smartFeatures.js');
  assert.match(source, /upsertMealPlanEntries/);
  assert.match(source, /saveGeneratedRecipesAndPlan/);
  assert.match(source, /beginOperation/);
  assert.match(source, /if \(idempotency\.cached\) return res\.json\(idempotency\.response\);\s+await claimAiBudget/);
  assert.doesNotMatch(source, /for \(const entry of entries\)[\s\S]*setMealPlanEntry/);
});

test('SQL funkcije nisu dostupne anon i authenticated ulogama', () => {
  const sql = read('migrations/20260822_production_hardening.sql');
  assert.match(sql, /revoke all on function public\.upsert_meal_plan_entries\(uuid, jsonb, text, text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.upsert_meal_plan_entries\(uuid, jsonb, text, text\) to service_role/);
  assert.match(sql, /RECIPE_NOT_ACCESSIBLE/);
  assert.match(sql, /IDEMPOTENCY_CLAIM_NOT_FOUND/);
});

test('server rano validira env i dodaje request ID', () => {
  const source = read('src/index.js');
  assert.match(source, /import '\.\/config\.js'/);
  assert.match(source, /app\.use\(requestContext\)/);
  assert.match(source, /app\.get\('\/ready'/);
  assert.match(source, /requireAiBudget\(cost\)/);
});

test('AI budžetski RPC je zaključan na service_role i ažurira oba limita atomski', () => {
  const sql = read('migrations/20260822_staging_operations.sql');
  assert.match(sql, /for update/);
  assert.match(sql, /AI_DAILY_USER_LIMIT/);
  assert.match(sql, /AI_DAILY_GLOBAL_LIMIT/);
  assert.match(sql, /revoke all on function public\.claim_ai_budget/);
  assert.match(sql, /grant execute on function public\.claim_ai_budget[^\n]+to service_role/);
});
