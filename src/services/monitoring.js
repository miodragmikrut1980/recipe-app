import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { safeMonitoringPayload } from '../lib/monitoringPayload.js';

export async function notifyOperations(event, severity, fields = {}) {
  if (!config.errorWebhookUrl) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(config.errorWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(safeMonitoringPayload(event, severity, fields)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`WEBHOOK_HTTP_${response.status}`);
    return true;
  } catch (error) {
    logger.warn('monitoring_delivery_failed', { errorName: error?.name || 'Error' });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
