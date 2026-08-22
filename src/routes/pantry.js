import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uuidValue } from '../lib/validation.js';
import { listPantry, addPantryItem, updatePantryItem, deletePantryItem, consumeRecipeFromPantry } from '../services/pantry.js';
import { sendRouteError } from '../lib/httpError.js';
import { recordHouseholdActivity, requireHouseholdAdult } from '../services/householdAccess.js';

const router = Router();
router.use('/pantry', requireAuth);

function pantryInput(body, partial = false) {
  const result = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 200);
    if (!name) throw Object.assign(new Error('Naziv namirnice je obavezan'), { status: 400 });
    result.name = name;
  }
  if (!partial || body.quantity !== undefined) {
    const quantity = Number(body.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1000000) throw Object.assign(new Error('Količina nije važeća'), { status: 400 });
    result.quantity = quantity;
  }
  if (!partial || body.unit !== undefined) result.unit = String(body.unit || '').trim().slice(0, 40);
  if (!partial || body.category !== undefined) result.category = String(body.category || 'Ostalo').trim().slice(0, 80);
  if (!partial || body.location !== undefined) {
    const location = String(body.location || 'Ostava');
    if (!['Ostava','Frižider','Zamrzivač'].includes(location)) throw Object.assign(new Error('Lokacija nije važeća'), { status: 400 });
    result.location = location;
  }
  if (!partial || body.expiresOn !== undefined) {
    const expiresOn = body.expiresOn ? String(body.expiresOn) : null;
    if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw Object.assign(new Error('Rok mora biti YYYY-MM-DD'), { status: 400 });
    result.expiresOn = expiresOn;
  }
  return result;
}

router.get('/pantry', async (req, res) => { try { res.json({ items: await listPantry(req.user.id) }); } catch (error) { sendRouteError(res, error, 'Učitavanje ostave nije uspelo'); } });
router.post('/pantry', requireHouseholdAdult, async (req, res) => { try { const item = await addPantryItem(req.user.id, pantryInput(req.body)); await recordHouseholdActivity(req.user.id, { action: 'pantry_added', entityType: 'pantry', entityId: item.id, summary: `Dodato u ostavu: ${item.name}` }); res.status(201).json({ item }); } catch (error) { sendRouteError(res, error, 'Dodavanje u ostavu nije uspelo'); } });
router.put('/pantry/:id', requireHouseholdAdult, async (req, res) => { try { const item = await updatePantryItem(req.user.id, uuidValue(req.params.id, 'id'), pantryInput(req.body, true)); await recordHouseholdActivity(req.user.id, { action: 'pantry_updated', entityType: 'pantry', entityId: item.id, summary: `Izmenjeno u ostavi: ${item.name}` }); res.json({ item }); } catch (error) { sendRouteError(res, error, 'Izmena ostave nije uspela'); } });
router.delete('/pantry/:id', requireHouseholdAdult, async (req, res) => { try { const id = uuidValue(req.params.id, 'id'); await deletePantryItem(req.user.id, id); await recordHouseholdActivity(req.user.id, { action: 'pantry_removed', entityType: 'pantry', entityId: id, summary: 'Namirnica je uklonjena iz ostave' }); res.json({ success: true }); } catch (error) { sendRouteError(res, error, 'Brisanje iz ostave nije uspelo'); } });
router.post('/pantry/consume-recipe', requireHouseholdAdult, async (req, res) => { try { const recipeId = uuidValue(req.body?.recipeId, 'recipeId'); const changes = await consumeRecipeFromPantry(req.user.id, recipeId, req.body?.commit === true); if (req.body?.commit === true && changes.length) await recordHouseholdActivity(req.user.id, { action: 'pantry_consumed', entityType: 'recipe', entityId: recipeId, summary: `Potrošnja potvrđena za ${changes.length} namirnica` }); res.json({ changes }); } catch (error) { sendRouteError(res, error, 'Umanjenje ostave nije uspelo'); } });

export default router;
