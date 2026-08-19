import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.js';

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
    res.status(500).json({ error: err.message });
  }
});

/** Napravi novo domacinstvo i pridruzi me */
router.post('/household', async (req, res) => {
  const { name } = req.body;
  try {
    const { data: household, error } = await supabase
      .from('households')
      .insert({ name: name || 'Moje domaćinstvo' })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await supabase.from('profiles').update({ household_id: household.id }).eq('id', req.user.id);
    res.json({ household });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Pridruzi se postojecem domacinstvu preko invite koda */
router.post('/household/join', async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: 'Nedostaje "inviteCode"' });
  try {
    const { data: household } = await supabase
      .from('households')
      .select()
      .eq('invite_code', inviteCode.toLowerCase().trim())
      .maybeSingle();

    if (!household) return res.status(404).json({ error: 'Kod nije pronađen' });

    await supabase.from('profiles').update({ household_id: household.id }).eq('id', req.user.id);
    res.json({ household });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Napusti domacinstvo */
router.post('/household/leave', async (req, res) => {
  try {
    await supabase.from('profiles').update({ household_id: null }).eq('id', req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
