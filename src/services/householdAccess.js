import { createClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function getHouseholdContext(userId) {
  const { data, error } = await supabase.from('profiles').select('household_id,household_role').eq('id', userId).maybeSingle();
  if (error) throw new Error(`Učitavanje uloge nije uspelo: ${error.message}`);
  return { householdId: data?.household_id || null, role: data?.household_role || 'adult' };
}

export async function requireHouseholdAdult(req, res, next) {
  try {
    const context = await getHouseholdContext(req.user.id);
    req.householdContext = context;
    if (context.householdId && context.role === 'child') throw new HttpError(403, 'Dečji nalog može da pregleda sadržaj, ali ovu izmenu mora potvrditi odrasli član.');
    next();
  } catch (error) { next(error); }
}

export async function recordHouseholdActivity(userId, activity) {
  try {
    const context = await getHouseholdContext(userId);
    if (!context.householdId) return;
    const row = { household_id: context.householdId, actor_user_id: userId, action: activity.action, entity_type: activity.entityType, entity_id: activity.entityId || null, summary: String(activity.summary).slice(0, 240), metadata: activity.metadata || {} };
    const { error } = await supabase.from('household_activity').insert(row);
    if (error) throw error;
  } catch (error) { logger.warn('household_activity_write_failed', { userId, message: error.message }); }
}

export async function listHouseholdActivity(userId, limit = 50) {
  const context = await getHouseholdContext(userId);
  if (!context.householdId) return [];
  const { data, error } = await supabase.from('household_activity').select('id,actor_user_id,action,entity_type,entity_id,summary,metadata,created_at').eq('household_id', context.householdId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`Učitavanje aktivnosti nije uspelo: ${error.message}`);
  const ids = [...new Set(data.map((row) => row.actor_user_id).filter(Boolean))];
  const { data: profiles, error: profileError } = ids.length ? await supabase.from('profiles').select('id,display_name').in('id', ids) : { data: [], error: null };
  if (profileError) throw new Error(`Učitavanje članova nije uspelo: ${profileError.message}`);
  const names = new Map(profiles.map((profile) => [profile.id, profile.display_name || 'Član']));
  return data.map((row) => ({ id: row.id, actorName: names.get(row.actor_user_id) || 'Bivši član', action: row.action, entityType: row.entity_type, entityId: row.entity_id, summary: row.summary, metadata: row.metadata, createdAt: row.created_at }));
}
