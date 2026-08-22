import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.js';
import { sendRouteError } from '../lib/httpError.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const router = Router();

router.use(requireAuth);

/** Info o mom domacinstvu (ili null ako nisam ni u jednom) */
router.get('/household', async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('household_id, households(id, name, invite_code)')
      .eq('id', req.user.id)
      .maybeSingle();

    res.json({ household: profile?.households || null });
  } catch (err) {
    sendRouteError(res, err, 'Učitavanje domaćinstva nije uspelo');
  }
});

/** Napravi novo domacinstvo i pridruzi me */
router.post('/household', async (req, res) => {
  const { name } = req.body;
  try {
    const { data: current, error: currentError } = await supabase.from('profiles').select('household_id').eq('id', req.user.id).maybeSingle();
    if (currentError) throw new Error(currentError.message);
    if (current?.household_id) return res.status(409).json({ error: 'Već pripadaš domaćinstvu. Prvo ga napusti.' });
    const { data: household, error } = await supabase.rpc('create_household_for_user', {
      p_user_id: req.user.id,
      p_name: typeof name === 'string' ? name : 'Moje domaćinstvo',
    }).single();
    if (error) throw new Error(error.message);
    res.json({ household });
  } catch (err) {
    sendRouteError(res, err, 'Kreiranje domaćinstva nije uspelo');
  }
});

/** Pridruzi se postojecem domacinstvu preko invite koda */
router.post('/household/join', async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: 'Nedostaje "inviteCode"' });
  try {
    const { data: current, error: currentError } = await supabase.from('profiles').select('household_id').eq('id', req.user.id).maybeSingle();
    if (currentError) throw new Error(currentError.message);
    if (current?.household_id) return res.status(409).json({ error: 'Već pripadaš domaćinstvu. Prvo ga napusti.' });
    const { data: household, error } = await supabase.rpc('join_household_for_user', {
      p_user_id: req.user.id,
      p_invite_code: inviteCode.toLowerCase().trim(),
    }).single();
    if (error?.message?.includes('INVITE_NOT_FOUND')) return res.status(404).json({ error: 'Kod nije pronađen' });
    if (error) throw new Error(error.message);
    res.json({ household });
  } catch (err) {
    sendRouteError(res, err, 'Pridruživanje domaćinstvu nije uspelo');
  }
});

/** Napusti domacinstvo */
router.post('/household/leave', async (req, res) => {
  try {
    const { error } = await supabase.from('profiles').update({ household_id: null }).eq('id', req.user.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    sendRouteError(res, err, 'Napuštanje domaćinstva nije uspelo');
  }
});

export default router;
