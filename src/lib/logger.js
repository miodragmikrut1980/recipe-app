import { randomUUID } from 'node:crypto';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:sk-ant-|sk-|sb_secret_)[A-Za-z0-9._-]+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

export function redact(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text.slice(0, 500);
}

export function errorSummary(error) {
  if (!error) return { name: 'Error', message: 'Unknown error' };
  const summary = {
    name: redact(error.name || 'Error'),
    message: redact(error.message || 'Unexpected error'),
  };
  if (error.code) summary.code = redact(error.code);
  if (Number.isInteger(error.status)) summary.status = error.status;
  if (process.env.NODE_ENV !== 'production' && error.stack) summary.stack = redact(error.stack);
  return summary;
}

function write(level, event, fields = {}) {
  const payload = { timestamp: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, error, fields = {}) => write('error', event, { ...fields, error: errorSummary(error) }),
};

export function requestContext(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const startedAt = Date.now();
  res.on('finish', () => logger.info('http_request', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status: res.statusCode,
    durationMs: Date.now() - startedAt,
  }));
  next();
}

export function errorEnvelope(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      return originalJson({ ...body, requestId: body.requestId || req.requestId });
    }
    return originalJson(body);
  };
  next();
}
