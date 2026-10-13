import { HttpError } from '../utils/http.js';

export function notFoundHandler(_req, _res, next) {
  next(new HttpError(404, 'Route not found'));
}

export function errorHandler(err, _req, res, _next) {
  if (err.code === '23505') return res.status(409).json({ error: 'That already exists' });
  if (err.code === '23503') return res.status(409).json({ error: 'This is linked to other records and cannot be removed' });
  if (err.code === '22P02') return res.status(400).json({ error: 'Invalid value' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message, details: err.details });
}
