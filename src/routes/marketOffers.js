import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { findMarketOffers } from '../services/marketOffers.js';
import { sendRouteError } from '../lib/httpError.js';

const router = Router();
router.post('/market-offers/search', requireAuth, async (req, res) => {
  if (!Array.isArray(req.body?.names) || req.body.names.length > 50) return res.status(400).json({ error: 'names mora biti niz do 50 namirnica' });
  try { res.json({ offers: await findMarketOffers(req.body.names.map((name) => String(name).slice(0, 200))) }); }
  catch (error) { sendRouteError(res, error, 'Učitavanje cena nije uspelo'); }
});
export default router;
