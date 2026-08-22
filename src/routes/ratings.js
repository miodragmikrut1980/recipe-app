import { Router } from 'express';
import { setRating, getMyRatings } from '../services/ratings.js';
import { requireAuth } from '../middleware/auth.js';
import { uuidValue } from '../lib/validation.js';
import { sendRouteError } from '../lib/httpError.js';

const router = Router();
router.use(requireAuth);

router.get('/ratings', async (req, res) => {
  try {
    const ratings = await getMyRatings(req.user.id);
    res.json({ ratings });
  } catch (err) {
    sendRouteError(res, err, 'Učitavanje ocena nije uspelo');
  }
});

router.put('/recipes/:id/rating', async (req, res) => {
  const { rating } = req.body;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Ocena mora biti ceo broj od 1 do 5' });
  }
  try {
    await setRating(uuidValue(req.params.id, 'id'), req.user.id, rating);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Čuvanje ocene nije uspelo' });
  }
});

export default router;
