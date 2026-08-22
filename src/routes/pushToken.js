import { Router } from 'express';
import { registerPushToken } from '../services/pushNotifications.js';
import { requireAuth } from '../middleware/auth.js';
import { sendRouteError } from '../lib/httpError.js';

const router = Router();

router.post('/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Nedostaje "token"' });
  if (typeof token !== 'string' || token.length > 200 || !/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)) {
    return res.status(400).json({ error: 'Nevažeći Expo push token' });
  }
  try {
    await registerPushToken(req.user.id, token);
    res.json({ success: true });
  } catch (err) {
    sendRouteError(res, err, 'Čuvanje push tokena nije uspelo');
  }
});

export default router;
