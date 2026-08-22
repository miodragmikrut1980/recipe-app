import { createClient } from '@supabase/supabase-js';
import { sendPushNotification } from './pushNotifications.js';
import { getAccessibleRecipe } from './db.js';
import { logger } from '../lib/logger.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FAVORITE_THRESHOLD = 4; // ocena 4 ili 5 = "omiljeno"

/**
 * Postavlja/azurira ocenu korisnika za recept. Ako je ocena dobra (4-5) i
 * korisnik je deo domacinstva, obavesti ostale clanove push notifikacijom.
 */
export async function setRating(recipeId, userId, rating) {
  await getAccessibleRecipe(recipeId, userId);
  const { data, error } = await supabase
    .from('recipe_ratings')
    .upsert({ recipe_id: recipeId, user_id: userId, rating }, { onConflict: 'recipe_id,user_id' })
    .select()
    .single();

  if (error) throw new Error(`Cuvanje ocene nije uspelo: ${error.message}`);

  if (rating >= FAVORITE_THRESHOLD) {
    notifyHouseholdOfGoodRating(recipeId, userId, rating).catch((err) =>
      logger.warn('household_rating_notification_failed', { errorName: err?.name || 'Error' })
    );
  }

  return data;
}

async function notifyHouseholdOfGoodRating(recipeId, raterId, rating) {
  const [{ data: profile }, { data: recipe }, { data: rater }] = await Promise.all([
    supabase.from('profiles').select('household_id').eq('id', raterId).maybeSingle(),
    supabase.from('recipes').select('title').eq('id', recipeId).maybeSingle(),
    supabase.auth.admin.getUserById(raterId),
  ]);

  if (!profile?.household_id || !recipe) return; // nije u domacinstvu — nema koga da obavesti

  const { data: members } = await supabase
    .from('profiles')
    .select('id')
    .eq('household_id', profile.household_id)
    .neq('id', raterId);

  if (!members || members.length === 0) return;

  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('token')
    .in('user_id', members.map((m) => m.id));

  if (!tokens || tokens.length === 0) return;

  const raterName = rater?.user?.email?.split('@')[0] || 'Neko iz porodice';
  const stars = '⭐'.repeat(rating);

  await sendPushNotification(
    tokens.map((t) => t.token),
    `${raterName} je oduševljen/a receptom!`,
    `"${recipe.title}" je ocenjen sa ${stars}`,
    { recipeId }
  );
}

/** Vraca mapu {recipeId: rating} za sve recepte koje je korisnik ocenio. */
export async function getMyRatings(userId) {
  const { data, error } = await supabase
    .from('recipe_ratings')
    .select('recipe_id, rating')
    .eq('user_id', userId);

  if (error) throw new Error(`Ucitavanje ocena nije uspelo: ${error.message}`);

  const map = {};
  for (const row of data) map[row.recipe_id] = row.rating;
  return map;
}
