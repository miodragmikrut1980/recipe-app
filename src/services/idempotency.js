import { createClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/httpError.js';
import { validateIdempotencyKey } from '../lib/idempotencyKey.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function beginOperation(userId, operation, key) {
  const validKey = validateIdempotencyKey(key);
  if (!validKey) return { enabled: false };
  const { data, error } = await supabase.rpc('claim_idempotency_key', {
    p_user_id: userId, p_operation: operation, p_key: validKey,
  });
  if (error) throw new Error(`Idempotency provera nije uspela: ${error.message}`);
  if (data?.state === 'completed') return { enabled: true, cached: true, response: data.response };
  if (data?.state === 'processing') throw new HttpError(409, 'Isti zahtev se već obrađuje');
  return { enabled: true, cached: false, key: validKey };
}

export async function completeOperation(userId, operation, key, response) {
  if (!key) return;
  const { error } = await supabase.from('idempotency_keys').update({ status: 'completed', response, updated_at: new Date().toISOString() })
    .eq('user_id', userId).eq('operation', operation).eq('key', key);
  if (error) throw new Error(`Idempotency završetak nije uspeo: ${error.message}`);
}

export async function abandonOperation(userId, operation, key) {
  if (!key) return;
  await supabase.from('idempotency_keys').delete().eq('user_id', userId).eq('operation', operation).eq('key', key).eq('status', 'processing');
}
