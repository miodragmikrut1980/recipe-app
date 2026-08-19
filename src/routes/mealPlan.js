import { Router } from 'express';
import { setMealPlanEntry, removeMealPlanEntry, getMealPlanRange } from '../services/mealPlan.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use('/meal-plan', requireAuth);

router.get('/meal-plan', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Nedostaju "start" i "end" query parametri (YYYY-MM-DD)' });
  }
  try {
    const entries = await getMealPlanRange(start, end, req.user.id);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/meal-plan', async (req, res) => {
  const { date, mealType, recipeId } = req.body;
  if (!date || !mealType || !recipeId) {
    return res.status(400).json({ error: 'Nedostaju "date", "mealType" ili "recipeId"' });
  }
  try {
    const entry = await setMealPlanEntry({ date, mealType, recipeId }, req.user.id);
    res.json({ entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/meal-plan', async (req, res) => {
  const { date, mealType } = req.query;
  if (!date || !mealType) {
    return res.status(400).json({ error: 'Nedostaju "date" ili "mealType" query parametri' });
  }
  try {
    await removeMealPlanEntry({ date, mealType }, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
