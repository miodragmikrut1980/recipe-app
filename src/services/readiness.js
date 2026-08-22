import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function checkReadiness(timeoutMs = 3000) {
  const databaseCheck = supabase.from('profiles').select('id', { head: true, count: 'exact' }).limit(1);
  const timeout = new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
    id.unref?.();
  });
  const { error } = await Promise.race([databaseCheck, timeout]);
  if (error) throw new Error('DATABASE_UNAVAILABLE');
  return { status: 'ready' };
}
