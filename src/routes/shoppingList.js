import { Router } from 'express';
import {
  generateShoppingList,
  saveShoppingListState,
  loadShoppingListState,
} from '../services/shoppingList.js';
import { requireAuth } from '../middleware/auth.js';
import { uuidValue } from '../lib/validation.js';
import { sendRouteError } from '../lib/httpError.js';
import { recordHouseholdActivity, requireHouseholdAdult } from '../services/householdAccess.js';

const router = Router();
router.use('/shopping-list', requireAuth);

router.post('/shopping-list/generate', requireHouseholdAdult, async (req, res) => {
  const { recipeIds } = req.body;
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(400).json({ error: 'Nedostaje "recipeIds" (niz id-jeva recepata)' });
  }
  try {
    if (recipeIds.length > 50) return res.status(400).json({ error: 'Najviše 50 recepata po listi' });
    const validIds = recipeIds.map((id, index) => uuidValue(id, `recipeIds[${index}]`));
    const items = await generateShoppingList(validIds, req.user.id);
    res.json({ items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Generisanje liste nije uspelo' });
  }
});

router.get('/shopping-list', async (req, res) => {
  try {
    res.json(await loadShoppingListState(req.user.id));
  } catch (err) {
    sendRouteError(res, err, 'Učitavanje liste nije uspelo');
  }
});

router.put('/shopping-list', requireHouseholdAdult, async (req, res) => {
  const { items, baseRevision } = req.body;
  if (!Array.isArray(items) || items.length > 500) {
    return res.status(400).json({ error: 'Nedostaje "items" (niz)' });
  }
  try {
    if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) return res.status(400).json({ error: 'baseRevision nije važeći' });
    const safeItems = items.map((item) => ({
      name: String(item?.name || '').trim().slice(0, 200),
      amount: String(item?.amount || '').trim().slice(0, 100),
      recipeTitle: item?.recipeTitle ? String(item.recipeTitle).trim().slice(0, 200) : undefined,
      checked: Boolean(item?.checked),
    })).filter((item) => item.name);
    const sync = await saveShoppingListState(safeItems, req.user.id, baseRevision ?? null);
    await recordHouseholdActivity(req.user.id, { action: 'shopping_updated', entityType: 'shopping', summary: `Lista za kupovinu ažurirana · ${safeItems.length} stavki` });
    res.json({ success: true, ...sync });
  } catch (err) {
    sendRouteError(res, err, 'Čuvanje liste nije uspelo');
  }
});

export default router;
