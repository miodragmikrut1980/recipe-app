import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { normalizeIngredientName } from '../src/lib/ingredientName.js';

const filePath = process.argv[2];
if (!filePath) throw new Error('Upotreba: npm run offers:import -- putanja/do/ponuda.json');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Nedostaju SUPABASE_URL i SUPABASE_SERVICE_KEY');

const raw = JSON.parse(await readFile(filePath, 'utf8'));
if (!Array.isArray(raw) || raw.length > 10000) throw new Error('Fajl mora biti JSON niz do 10.000 ponuda');

const rows = raw.map((offer, index) => {
  const market = String(offer.market || '').trim().slice(0, 100);
  const productName = String(offer.productName || '').trim().slice(0, 200);
  const priceCents = Number(offer.priceCents);
  const validFrom = new Date(offer.validFrom || Date.now());
  const validUntil = new Date(offer.validUntil);
  const sourceUrl = offer.sourceUrl ? String(offer.sourceUrl).trim().slice(0, 2048) : null;
  if (!market || !productName || !Number.isInteger(priceCents) || priceCents <= 0) throw new Error(`Nevažeća ponuda na indeksu ${index}`);
  if (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom) throw new Error(`Nevažeći period na indeksu ${index}`);
  if (sourceUrl && !sourceUrl.startsWith('https://')) throw new Error(`sourceUrl mora biti HTTPS na indeksu ${index}`);
  return { market, product_name: productName, normalized_name: normalizeIngredientName(offer.ingredientName || productName), price_cents: priceCents, currency: 'RSD', unit_label: String(offer.unitLabel || 'kom').slice(0, 40), source_url: sourceUrl, valid_from: validFrom.toISOString(), valid_until: validUntil.toISOString() };
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
for (let offset = 0; offset < rows.length; offset += 500) {
  const { error } = await supabase.from('market_offers').insert(rows.slice(offset, offset + 500));
  if (error) throw new Error(`Uvoz nije uspeo: ${error.message}`);
}
console.log(JSON.stringify({ imported: rows.length }));
