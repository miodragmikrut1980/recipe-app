import { redact } from './logger.js';

const ALLOWED_FIELDS = new Set(['requestId', 'route', 'status', 'errorName', 'code', 'userId', 'cost', 'scope']);

export function safeMonitoringPayload(event, severity, fields = {}, environment = process.env.NODE_ENV || 'development') {
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key) && value != null) safeFields[key] = redact(value);
  }
  return {
    event: redact(event),
    severity: ['warning', 'error', 'critical'].includes(severity) ? severity : 'error',
    service: 'recipe-app-backend',
    environment: redact(environment),
    timestamp: new Date().toISOString(),
    ...safeFields,
  };
}
