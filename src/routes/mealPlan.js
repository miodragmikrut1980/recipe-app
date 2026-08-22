import { Router } from 'express';
import { setMealPlanEntry, removeMealPlanEntry, getMealPlanRange } from '../services/mealPlan.js';
import { requireAuth } from '../middleware/auth.js';
import { dateValue, enumValue, uuidValue } from '../lib/validation.js';

const router = Router();
router.use('/meal-plan', requireAuth);

router.get('/meal-plan', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Nedostaju "start" i "end" query parametri (YYYY-MM-DD)' });
  }
  try {
    const validStart = dateValue(start, 'start');
    const validEnd = dateValue(end, 'end');
    if (validEnd < validStart) return res.status(400).json({ error: '"end" ne može biti pre "start"' });
    const entries = await getMealPlanRange(validStart, validEnd, req.user.id);
    res.json({ entries });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Učitavanje plana nije uspelo' });
  }
});

router.put('/meal-plan', async (req, res) => {
  const { date, mealType, recipeId } = req.body;
  if (!date || !mealType || !recipeId) {
    return res.status(400).json({ error: 'Nedostaju "date", "mealType" ili "recipeId"' });
  }
  try {
    const entry = await setMealPlanEntry({ date: dateValue(date, 'date'), mealType: enumValue(mealType, 'mealType', ['breakfast', 'lunch', 'dinner']), recipeId: uuidValue(recipeId, 'recipeId') }, req.user.id);
    res.json({ entry });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Čuvanje plana nije uspelo' });
  }
});

router.delete('/meal-plan', async (req, res) => {
  const { date, mealType } = req.query;
  if (!date || !mealType) {
    return res.status(400).json({ error: 'Nedostaju "date" ili "mealType" query parametri' });
  }
  try {
    await removeMealPlanEntry({ date: dateValue(date, 'date'), mealType: enumValue(mealType, 'mealType', ['breakfast', 'lunch', 'dinner']) }, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Brisanje plana nije uspelo' });
  }
});

export default router;
