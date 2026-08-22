const DIACRITICS = /[\u0300-\u036f]/g;

export function normalizeIngredientName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(svez|sveza|sveze|sitno|seckan|seckana|mleven|mlevena|po ukusu)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pantryContainsIngredient(pantryName, ingredientName) {
  const pantry = normalizeIngredientName(pantryName);
  const ingredient = normalizeIngredientName(ingredientName);
  if (!pantry || !ingredient) return false;
  if (pantry === ingredient) return true;
  return ` ${pantry} `.includes(` ${ingredient} `) || ` ${ingredient} `.includes(` ${pantry} `);
}

const UNIT_FACTORS = new Map([
  ['g', ['g', 1]], ['gr', ['g', 1]], ['kg', ['g', 1000]],
  ['ml', ['ml', 1]], ['l', ['ml', 1000]], ['dl', ['ml', 100]],
  ['kom', ['kom', 1]], ['komad', ['kom', 1]], ['komada', ['kom', 1]],
]);

function parsedAmount(amount, separateUnit = '') {
  const match = String(amount || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!match) return null;
  const quantity = Number(match[1].replace(',', '.'));
  const displayUnit = (separateUnit || match[2]).trim().toLowerCase();
  const [baseUnit, factor] = UNIT_FACTORS.get(displayUnit) || [displayUnit, 1];
  return { quantity: quantity * factor, baseUnit, displayUnit, factor };
}

export function buildPantryConsumption(ingredients, pantryItems) {
  const stock = pantryItems.map((item) => ({ ...item, parsed: parsedAmount(item.quantity, item.unit), remaining: Number(item.quantity) }));
  for (const ingredient of ingredients || []) {
    const needed = parsedAmount(ingredient.amount);
    if (!needed || needed.quantity <= 0) continue;
    const match = stock.find((entry) => entry.remaining > 0 && entry.parsed && entry.parsed.baseUnit === needed.baseUnit && pantryContainsIngredient(entry.name, ingredient.name));
    if (!match) continue;
    const deduction = Math.min(match.remaining, needed.quantity / match.parsed.factor);
    match.remaining = Number(Math.max(0, match.remaining - deduction).toFixed(3));
  }
  return stock.filter((item) => item.remaining < Number(item.quantity)).map((item) => ({ id: item.id, name: item.name, deduction: Number((Number(item.quantity) - item.remaining).toFixed(3)), unit: item.unit, before: Number(item.quantity), after: item.remaining }));
}

export function subtractPantryFromShopping(items, pantryItems) {
  const stock = pantryItems.map((item) => ({ ...item, parsed: parsedAmount(item.quantity, item.unit), remaining: Number(item.quantity) }));
  const result = [];
  for (const item of items) {
    const match = stock.find((entry) => entry.remaining > 0 && pantryContainsIngredient(entry.name, item.name));
    if (!match) { result.push(item); continue; }
    const needed = parsedAmount(item.amount);
    if (!needed || !match.parsed || needed.baseUnit !== match.parsed.baseUnit) {
      match.remaining = Math.max(0, match.remaining - 1);
      continue;
    }
    const availableBase = match.remaining * match.parsed.factor;
    if (availableBase >= needed.quantity) {
      match.remaining -= needed.quantity / match.parsed.factor;
      continue;
    }
    const missingBase = needed.quantity - availableBase;
    match.remaining = 0;
    const missingDisplay = missingBase / needed.factor;
    result.push({ ...item, amount: `${Number(missingDisplay.toFixed(3))}${needed.displayUnit ? ` ${needed.displayUnit}` : ''}` });
  }
  return result;
}
