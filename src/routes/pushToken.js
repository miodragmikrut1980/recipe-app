import { Router } from 'express';
import { registerPushToken } from '../services/pushNotifications.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Nedostaje "token"' });
  try {
    await registerPushToken(req.user.id, token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
