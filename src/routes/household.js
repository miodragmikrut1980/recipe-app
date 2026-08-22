import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.js';
import { sendRouteError } from '../lib/httpError.js';
import { uuidValue } from '../lib/validation.js';
import { listHouseholdActivity, recordHouseholdActivity } from '../services/householdAccess.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const router = Router();

function householdRpcError(error) {
  const message = String(error?.message || '');
  if (message.includes('OWNER_REQUIRED')) return Object.assign(new Error('Samo vlasnik može da uradi ovu radnju.'), { status: 403 });
  if (message.includes('MEMBER_NOT_FOUND')) return Object.assign(new Error('Član nije pronađen u ovom domaćinstvu.'), { status: 404 });
  if (message.includes('OWNER_TRANSFER_REQUIRED')) return Object.assign(new Error('Pre napuštanja prenesi vlasništvo na drugog člana.'), { status: 409 });
  if (message.includes('OWNER_')) return Object.assign(new Error('Ova radnja nije dozvoljena za vlasnika.'), { status: 409 });
  return error;
}

router.use(requireAuth);

/** Info o mom domacinstvu (ili null ako nisam ni u jednom) */
router.get('/household', async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('household_id, household_role, display_name, households(id, name, invite_code, owner_id)')
      .eq('id', req.user.id)
      .maybeSingle();

    if (!profile?.households) return res.json({ household: null, members: [] });
    const { data: memberRows, error: memberError } = await supabase.from('profiles').select('id,display_name,household_role').eq('household_id', profile.household_id).order('created_at');
    if (memberError) throw new Error(memberError.message);
    const members = await Promise.all(memberRows.map(async (member) => {
      if (member.display_name) return { id: member.id, displayName: member.display_name, role: member.household_role, isMe: member.id === req.user.id };
      const { data } = await supabase.auth.admin.getUserById(member.id);
      return { id: member.id, displayName: data?.user?.email?.split('@')[0] || 'Član', role: member.household_role, isMe: member.id === req.user.id };
    }));
    res.json({ household: profile.households, members, myRole: profile.household_role });
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
    const { error } = await supabase.rpc('leave_household_for_user', { p_user_id: req.user.id });
    if (error?.message?.includes('OWNER_TRANSFER_REQUIRED')) return res.status(409).json({ error: 'Pre napuštanja prenesi vlasništvo na drugog člana.' });
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    sendRouteError(res, err, 'Napuštanje domaćinstva nije uspelo');
  }
});

router.patch('/profile', async (req, res) => {
  const displayName = String(req.body?.displayName || '').trim().slice(0, 80);
  if (!displayName) return res.status(400).json({ error: 'Ime je obavezno' });
  try { const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', req.user.id); if (error) throw error; res.json({ success: true }); }
  catch (error) { sendRouteError(res, error, 'Čuvanje imena nije uspelo'); }
});

router.get('/household/activity', async (req, res) => {
  try { res.json({ activities: await listHouseholdActivity(req.user.id, 50) }); }
  catch (error) { sendRouteError(res, error, 'Učitavanje istorije nije uspelo'); }
});

router.put('/household/members/:id/role', async (req, res) => {
  if (!['adult','child'].includes(req.body?.role)) return res.status(400).json({ error: 'Uloga nije važeća' });
  try { const memberId = uuidValue(req.params.id, 'id'); const { error } = await supabase.rpc('set_household_member_role', { p_owner_id: req.user.id, p_member_id: memberId, p_role: req.body.role }); if (error) throw householdRpcError(error); await recordHouseholdActivity(req.user.id, { action: 'member_role_changed', entityType: 'member', entityId: memberId, summary: `Uloga člana je promenjena na ${req.body.role === 'child' ? 'Dete' : 'Odrasli'}` }); res.json({ success: true }); }
  catch (error) { sendRouteError(res, error, 'Promena uloge nije uspela'); }
});

router.delete('/household/members/:id', async (req, res) => {
  try { const memberId = uuidValue(req.params.id, 'id'); const { error } = await supabase.rpc('remove_household_member', { p_owner_id: req.user.id, p_member_id: memberId }); if (error) throw householdRpcError(error); await recordHouseholdActivity(req.user.id, { action: 'member_removed', entityType: 'member', entityId: memberId, summary: 'Član je uklonjen iz domaćinstva' }); res.json({ success: true }); }
  catch (error) { sendRouteError(res, error, 'Uklanjanje člana nije uspelo'); }
});

router.post('/household/transfer', async (req, res) => {
  if (!req.body?.memberId) return res.status(400).json({ error: 'memberId je obavezan' });
  try { const memberId = uuidValue(req.body.memberId, 'memberId'); const { error } = await supabase.rpc('transfer_household_ownership', { p_owner_id: req.user.id, p_member_id: memberId }); if (error) throw householdRpcError(error); await recordHouseholdActivity(req.user.id, { action: 'ownership_transferred', entityType: 'member', entityId: memberId, summary: 'Vlasništvo domaćinstva je preneto' }); res.json({ success: true }); }
  catch (error) { sendRouteError(res, error, 'Prenos vlasništva nije uspeo'); }
});

export default router;
