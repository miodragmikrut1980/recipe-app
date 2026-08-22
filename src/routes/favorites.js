import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uuidValue } from '../lib/validation.js';
import { listFavorites, setFavorite } from '../services/favorites.js';
import { sendRouteError } from '../lib/httpError.js';

const router = Router();
router.use(requireAuth);
router.get('/favorites', async (req, res) => { try { res.json({ recipeIds: await listFavorites(req.user.id) }); } catch (error) { sendRouteError(res, error, 'Učitavanje favorita nije uspelo'); } });
router.put('/recipes/:id/favorite', async (req, res) => {
  if (typeof req.body?.favorite !== 'boolean') return res.status(400).json({ error: 'Polje favorite mora biti boolean' });
  try { await setFavorite(uuidValue(req.params.id, 'id'), req.user.id, req.body.favorite); res.json({ success: true }); }
  catch (error) { sendRouteError(res, error, 'Čuvanje favorita nije uspelo'); }
});
export default router;
