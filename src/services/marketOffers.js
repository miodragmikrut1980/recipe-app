import { createClient } from '@supabase/supabase-js';
import { normalizeIngredientName, pantryContainsIngredient } from '../lib/ingredientName.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function findMarketOffers(names) {
  const normalized = [...new Set(names.map(normalizeIngredientName).filter(Boolean))].slice(0, 50);
  if (!normalized.length) return [];
  const { data, error } = await supabase.from('market_offers').select('id,market,product_name,normalized_name,price_cents,currency,unit_label,source_url,valid_until').lte('valid_from', new Date().toISOString()).gt('valid_until', new Date().toISOString()).order('price_cents').limit(1000);
  if (error) throw new Error(`Učitavanje cena nije uspelo: ${error.message}`);
  return data.filter((row) => normalized.some((name) => pantryContainsIngredient(row.normalized_name, name))).map((row) => ({ id: row.id, market: row.market, productName: row.product_name, ingredientName: row.normalized_name, priceCents: row.price_cents, currency: row.currency, unitLabel: row.unit_label, sourceUrl: row.source_url, validUntil: row.valid_until }));
}
