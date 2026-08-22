#!/usr/bin/env node
/**
 * Smoke test za backend — pokreni sa: node smoke-test.js
 *
 * Ocekuje da backend radi na http://localhost:3000 i da su u .env postavljeni
 * ispravni kljucevi. Skripta sama registruje test korisnika preko Supabase-a,
 * dobije token, i prodje kroz sve endpointe redom. Na kraju ispise rezime.
 *
 * Pre pokretanja: npm install (potrebni su @supabase/supabase-js i dotenv,
 * vec su u zavisnostima projekta).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API = process.env.TEST_API_URL || 'http://localhost:3000';
const results = [];
let adminClient;
let createdUserId;
let createdHouseholdId;

function log(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`\nSmoke test protiv: ${API}\n`);

  // 0. Health check (bez auth)
  try {
    const r = await fetch(`${API}/health`);
    log('GET /health', r.ok);
    const ready = await fetch(`${API}/ready`);
    log('GET /ready (Supabase veza)', ready.ok, `status: ${ready.status}`);
  } catch (err) {
    log('GET /health', false, `Server nedostupan: ${err.message}. Da li je backend pokrenut?`);
    return finish();
  }

  // 1. Napravi test korisnika i uzmi token
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  adminClient = supabase;
  const email = `smoke-test-${Date.now()}@example.com`;
  const password = 'Test1234!';
  let token;
  try {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) throw createErr;
    createdUserId = created.user.id;

    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY);
    const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;
    token = session.session.access_token;
    log('Auth: kreiranje test korisnika + login', true, email);
  } catch (err) {
    log('Auth: kreiranje test korisnika + login', false, err.message);
    return finish();
  }

  const authFetch = (path, options = {}) =>
    fetch(`${API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });

  // 2. Auth zastita: poziv bez tokena mora biti odbijen
  try {
    const r = await fetch(`${API}/recipes`);
    log('Auth zastita (poziv bez tokena vraca 401)', r.status === 401, `status: ${r.status}`);
  } catch (err) {
    log('Auth zastita', false, err.message);
  }

  // 3. Parsiranje recepta iz teksta (Claude API poziv)
  let recipeId = null;
  try {
    const r = await authFetch('/parse-recipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://instagram.com/p/smoke-test',
        text: 'Palacinke: 2 jaja, 250ml mleka, 150g brasna, prstohvat soli. Umutiti sve, peci na tiganju 2 minuta sa svake strane. Za 4 osobe.',
      }),
    });
    const data = await r.json();
    const ok = r.ok && data.recipe?.title && data.recipe?.ingredients?.length > 0;
    recipeId = data.recipe?.id;
    log('POST /parse-recipe (Claude parsiranje)', ok, ok ? `"${data.recipe.title}", ${data.recipe.ingredients.length} sastojaka` : JSON.stringify(data));
  } catch (err) {
    log('POST /parse-recipe', false, err.message);
  }

  // 4. Lista recepata
  try {
    const r = await authFetch('/recipes');
    const data = await r.json();
    log('GET /recipes', r.ok && Array.isArray(data.recipes), `${data.recipes?.length ?? '?'} recepata`);
  } catch (err) {
    log('GET /recipes', false, err.message);
  }

  if (recipeId) {
    // 5. Prilagodjavanje recepta
    try {
      const r = await authFetch('/customize-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId, instruction: 'prepolovi kolicine' }),
      });
      const data = await r.json();
      log('POST /customize-recipe', r.ok && data.recipe?.id, data.recipe?.title || JSON.stringify(data));
    } catch (err) {
      log('POST /customize-recipe', false, err.message);
    }

    // 6. Predlozi po sastojcima
    try {
      const r = await authFetch('/suggest-recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availableIngredients: ['jaja', 'mleko', 'brasno'] }),
      });
      const data = await r.json();
      log('POST /suggest-recipes', r.ok && Array.isArray(data.matches), `${data.matches?.length ?? '?'} pogodaka`);
    } catch (err) {
      log('POST /suggest-recipes', false, err.message);
    }

    // 7. Meal plan rucno
    try {
      const r = await authFetch('/meal-plan', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-08-15', mealType: 'lunch', recipeId }),
      });
      log('PUT /meal-plan', r.ok);
      const r2 = await authFetch('/meal-plan?start=2026-08-15&end=2026-08-15');
      const data2 = await r2.json();
      log('GET /meal-plan', r2.ok && data2.entries?.length === 1);
    } catch (err) {
      log('meal-plan', false, err.message);
    }

    // 8. Shopping lista
    try {
      const r = await authFetch('/shopping-list/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeIds: [recipeId] }),
      });
      const data = await r.json();
      log('POST /shopping-list/generate', r.ok && data.items?.length > 0, `${data.items?.length ?? 0} stavki`);
    } catch (err) {
      log('shopping-list', false, err.message);
    }
  }

  // 9. Household tok
  try {
    const r = await authFetch('/household', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test kuca' }),
    });
    const data = await r.json();
    const ok = r.ok && data.household?.invite_code;
    if (ok) createdHouseholdId = data.household.id;
    log('POST /household (kreiranje)', ok, ok ? `kod: ${data.household.invite_code}` : JSON.stringify(data));
  } catch (err) {
    log('POST /household', false, err.message);
  }

  // 10. Ciscenje: obrisi test recepte
  if (recipeId) {
    try {
      const r = await authFetch(`/recipes/${recipeId}`, { method: 'DELETE' });
      log('DELETE /recipes/:id', r.ok);
    } catch (err) {
      log('DELETE /recipes/:id', false, err.message);
    }
  }

  await finish();
}

async function finish() {
  if (adminClient && createdHouseholdId) {
    try { await adminClient.from('households').delete().eq('id', createdHouseholdId); } catch {}
  }
  if (adminClient && createdUserId) {
    try { await adminClient.auth.admin.deleteUser(createdUserId); } catch {}
  }
  summary();
}

function summary() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(40)}\nRezultat: ${passed}/${results.length} testova proslo\n`);
  if (passed < results.length) {
    console.log('Za padle testove: pogledaj logove backend servera za detalje greske.\n');
    process.exitCode = 1;
  }
}

main();
