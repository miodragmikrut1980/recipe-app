import { HttpError } from './httpError.js';

export function requireObject(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${name} mora biti objekat`);
  }
  return value;
}

export function stringValue(value, name, { required = true, max = 5000, trim = true } = {}) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, `Nedostaje "${name}"`);
    return undefined;
  }
  if (typeof value !== 'string') throw new HttpError(400, `"${name}" mora biti tekst`);
  const result = trim ? value.trim() : value;
  if (required && !result) throw new HttpError(400, `"${name}" ne sme biti prazan`);
  if (result.length > max) throw new HttpError(400, `"${name}" je predugačak (maksimum ${max})`);
  return result;
}

export function integerValue(value, name, { min, max, defaultValue } = {}) {
  const result = value == null ? defaultValue : value;
  if (!Number.isInteger(result)) throw new HttpError(400, `"${name}" mora biti ceo broj`);
  if (min != null && result < min) throw new HttpError(400, `"${name}" mora biti najmanje ${min}`);
  if (max != null && result > max) throw new HttpError(400, `"${name}" može biti najviše ${max}`);
  return result;
}

export function stringArray(value, name, { min = 0, max = 100, itemMax = 200 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new HttpError(400, `"${name}" mora biti niz sa ${min}-${max} stavki`);
  }
  return value.map((item, index) => stringValue(item, `${name}[${index}]`, { max: itemMax }));
}

export function uuidValue(value, name = 'id') {
  const result = stringValue(value, name, { max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new HttpError(400, `"${name}" nije validan UUID`);
  }
  return result;
}

export function dateValue(value, name) {
  const result = stringValue(value, name, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new HttpError(400, `"${name}" mora biti datum u formatu YYYY-MM-DD`);
  }
  return result;
}

export function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `"${name}" mora biti: ${allowed.join(', ')}`);
  return value;
}

export function httpUrl(value, name = 'url') {
  const result = stringValue(value, name, { max: 2048 });
  let parsed;
  try { parsed = new URL(result); } catch { throw new HttpError(400, `"${name}" nije validan URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, `"${name}" mora koristiti http ili https`);
  if (parsed.username || parsed.password) throw new HttpError(400, `"${name}" ne sme sadržati kredencijale`);
  return parsed.toString();
}

export function validateRecipePatch(body) {
  requireObject(body);
  const allowed = new Set(['title', 'servings', 'ingredients', 'steps', 'prepTimeMinutes', 'tags']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new HttpError(400, `Polje "${key}" nije dozvoljeno`);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'Nema polja za izmenu');
  const patch = {};
  if ('title' in body) patch.title = stringValue(body.title, 'title', { max: 200 });
  if ('servings' in body) patch.servings = body.servings === null ? null : integerValue(body.servings, 'servings', { min: 1, max: 100 });
  if ('prepTimeMinutes' in body) patch.prepTimeMinutes = body.prepTimeMinutes === null ? null : integerValue(body.prepTimeMinutes, 'prepTimeMinutes', { min: 0, max: 10080 });
  if ('steps' in body) patch.steps = stringArray(body.steps, 'steps', { max: 100, itemMax: 4000 });
  if ('tags' in body) patch.tags = stringArray(body.tags, 'tags', { max: 30, itemMax: 80 });
  if ('ingredients' in body) {
    if (!Array.isArray(body.ingredients) || body.ingredients.length > 300) throw new HttpError(400, '"ingredients" mora biti niz do 300 stavki');
    patch.ingredients = body.ingredients.map((item, index) => {
      requireObject(item, `ingredients[${index}]`);
      return {
        name: stringValue(item.name, `ingredients[${index}].name`, { max: 200 }),
        amount: stringValue(item.amount ?? '', `ingredients[${index}].amount`, { required: false, max: 100 }) ?? '',
      };
    });
  }
  return patch;
}

export function normalizeAiRecipe(value) {
  requireObject(value, 'AI recept');
  const result = validateRecipePatch({
    title: value.title || 'Nepoznat recept',
    servings: value.servings ?? null,
    ingredients: Array.isArray(value.ingredients) ? value.ingredients : [],
    steps: Array.isArray(value.steps) ? value.steps : [],
    prepTimeMinutes: value.prepTimeMinutes ?? null,
    tags: Array.isArray(value.tags) ? value.tags : [],
  });
  if (!result.ingredients.length && !result.steps.length) throw new HttpError(422, 'AI odgovor ne sadrži upotrebljiv recept');
  const nutrition = value.nutritionPerServing;
  result.nutritionPerServing = nutrition && typeof nutrition === 'object' && !Array.isArray(nutrition)
    ? Object.fromEntries(['calories', 'proteinGrams', 'carbsGrams', 'fatGrams'].map((key) => {
        const raw = nutrition[key];
        return [key, raw == null || !Number.isFinite(Number(raw)) ? null : Math.max(0, Math.min(100000, Number(raw)))];
      }))
    : null;
  return result;
}
