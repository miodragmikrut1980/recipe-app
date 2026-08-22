export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function sendRouteError(res, err, fallback = 'Operacija nije uspela') {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error(fallback, err);
  return res.status(status).json({ error: status >= 500 ? fallback : err.message, ...(err?.code ? { code: err.code } : {}) });
}
