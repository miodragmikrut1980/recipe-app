import { createClient } from '@supabase/supabase-js';
import { logger } from '../lib/logger.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Proverava Bearer token (Supabase Auth JWT) i kaci user objekat na req.
 * Mobilna app se loguje direktno preko Supabase-a i salje token uz svaki zahtev.
 */
export async function requireAuth(req, res, next) {
  if (req.user?.id) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn('auth_missing_token', { requestId: req.requestId, method: req.method, path: req.path });
    return res.status(401).json({ error: 'Nedostaje autorizacioni token' });
  }

  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    logger.warn('auth_invalid_token', { requestId: req.requestId, method: req.method, path: req.path });
    return res.status(401).json({ error: 'Nevažeći ili istekao token' });
  }

  req.user = data.user;
  next();
}
