import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { HttpError } from '../lib/httpError.js';
import { logger } from '../lib/logger.js';
import { notifyOperations } from './monitoring.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export async function claimAiBudget(userId, cost) {
  if (!Number.isInteger(cost) || cost < 1 || cost > 20) throw new Error('Nevažeća AI cena operacije');
  const { data, error } = await supabase.rpc('claim_ai_budget', {
    p_user_id: userId,
    p_cost: cost,
    p_user_limit: config.aiDailyUserCredits,
    p_global_limit: config.aiDailyGlobalCredits,
  });
  if (error) {
    if (error.message?.includes('AI_DAILY_USER_LIMIT')) {
      notifyOperations('ai_user_budget_reached', 'warning', { userId, cost, scope: 'user' });
      throw new HttpError(429, 'Dostigao si dnevni limit AI obrade. Pokušaj ponovo sutra.');
    }
    if (error.message?.includes('AI_DAILY_GLOBAL_LIMIT')) {
      notifyOperations('ai_global_budget_reached', 'critical', { cost, scope: 'global' });
      throw new HttpError(503, 'AI obrada je privremeno nedostupna. Pokušaj ponovo kasnije.');
    }
    throw new Error(`Provera AI budžeta nije uspela: ${error.message}`);
  }
  return data;
}

export function requireAiBudget(cost) {
  return async (req, res, next) => {
    try {
      const usage = await claimAiBudget(req.user.id, cost);
      logger.info('ai_budget_claimed', {
        requestId: req.requestId,
        route: req.path,
        cost,
        userCredits: usage?.userCredits,
        globalCredits: usage?.globalCredits,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
