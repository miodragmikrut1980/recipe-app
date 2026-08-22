import { HttpError } from './httpError.js';

export function validateIdempotencyKey(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new HttpError(400, 'Idempotency-Key mora imati 8-128 bezbednih karaktera');
  }
  return value;
}
