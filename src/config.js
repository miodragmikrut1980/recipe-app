const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

function positiveInteger(source, name, defaultValue) {
  if (source[name] == null || source[name] === '') return defaultValue;
  const value = Number(source[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} mora biti pozitivan ceo broj`);
  return value;
}

export function validateEnvironment(source = process.env) {
  const missing = REQUIRED.filter((name) => !source[name]?.trim());
  if (missing.length) {
    throw new Error(`Nedostaju obavezne environment promenljive: ${missing.join(', ')}`);
  }
  let supabaseUrl;
  try { supabaseUrl = new URL(source.SUPABASE_URL); }
  catch { throw new Error('SUPABASE_URL nije validan URL'); }
  if (supabaseUrl.protocol !== 'https:' && source.NODE_ENV === 'production') {
    throw new Error('SUPABASE_URL mora koristiti HTTPS u produkciji');
  }
  if (source.NODE_ENV === 'production' && !source.CORS_ORIGINS?.trim()) {
    throw new Error('CORS_ORIGINS mora biti eksplicitno podešen u produkciji');
  }
  if (source.ERROR_WEBHOOK_URL) {
    let webhookUrl;
    try { webhookUrl = new URL(source.ERROR_WEBHOOK_URL); }
    catch { throw new Error('ERROR_WEBHOOK_URL nije validan URL'); }
    if (source.NODE_ENV === 'production' && webhookUrl.protocol !== 'https:') {
      throw new Error('ERROR_WEBHOOK_URL mora koristiti HTTPS u produkciji');
    }
  }
  positiveInteger(source, 'AI_DAILY_USER_CREDITS', 60);
  positiveInteger(source, 'AI_DAILY_GLOBAL_CREDITS', 2000);
  return true;
}

validateEnvironment();

export const config = Object.freeze({
  aiDailyUserCredits: positiveInteger(process.env, 'AI_DAILY_USER_CREDITS', 60),
  aiDailyGlobalCredits: positiveInteger(process.env, 'AI_DAILY_GLOBAL_CREDITS', 2000),
  errorWebhookUrl: process.env.ERROR_WEBHOOK_URL?.trim() || null,
});
