import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'You do not have access to this') => new HttpError(403, msg);

// Wrap async route handlers so errors reach the error middleware
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.length ? `${first.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${first.message}`, result.error.issues);
  }
  return result.data;
}

export const money = z.coerce.number().min(0);
export const id = z.coerce.number().int().positive();
export const optStr = z.string().trim().optional().nullable().transform((v) => (v === '' ? null : v ?? null));

export { z };
