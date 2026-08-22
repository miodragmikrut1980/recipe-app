import { createClient } from '@supabase/supabase-js';
import { logger } from '../lib/logger.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * Expo push servis je besplatan i ne zahteva API kljuc — samo se salje
 * "Expo push token" koji mobilna app dobije preko expo-notifications.
 * Dokumentacija: https://docs.expo.dev/push-notifications/sending-notifications/
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function registerPushToken(userId, token) {
  const { error } = await supabase
    .from('push_tokens')
    .upsert({ user_id: userId, token, updated_at: new Date().toISOString() });

  if (error) throw new Error(`Cuvanje push tokena nije uspelo: ${error.message}`);
}

/**
 * Salje push notifikaciju jednom ili vise tokena odjednom. Ne baca gresku
 * ka pozivaocu ako Expo servis padne — notifikacije su "nice to have", ne
 * smeju da obore glavnu operaciju (npr. cuvanje ocene).
 */
export async function sendPushNotification(tokens, title, body, data = {}) {
  const validTokens = tokens.filter((t) => typeof t === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(t));
  if (validTokens.length === 0) return;

  const messages = validTokens.map((to) => ({ to, sound: 'default', title, body, data }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      logger.warn('expo_push_rejected', { status: response.status });
    }
  } catch (err) {
    logger.warn('expo_push_failed', { errorName: err?.name || 'Error' });
  }
}
