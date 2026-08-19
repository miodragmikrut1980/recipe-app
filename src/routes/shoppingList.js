import { Router } from 'express';
import {
  generateShoppingList,
  saveShoppingListState,
  loadShoppingListState,
} from '../services/shoppingList.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use('/shopping-list', requireAuth);

router.post('/shopping-list/generate', async (req, res) => {
  const { recipeIds } = req.body;
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(400).json({ error: 'Nedostaje "recipeIds" (niz id-jeva recepata)' });
  }
  try {
    const items = await generateShoppingList(recipeIds, req.user.id);
    await saveShoppingListState(items, req.user.id);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/shopping-list', async (req, res) => {
  try {
    const items = await loadShoppingListState(req.user.id);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/shopping-list', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Nedostaje "items" (niz)' });
  }
  try {
    await saveShoppingListState(items, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
