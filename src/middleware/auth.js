import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db.js';
import { HttpError, forbidden } from '../utils/http.js';

export function signToken(user, stationId) {
  return jwt.sign({ uid: user.id, sid: stationId ?? user.station_id ?? null, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

// Reads the bearer token, loads the user and works out which station they are acting in.
export async function attachUser(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();
    let payload;
    try { payload = jwt.verify(token, config.jwtSecret); } catch { return next(); }
    const user = await one(
      'SELECT id, station_id, role, name, username, email, phone, status, loyalty_points FROM users WHERE id = $1',
      [payload.uid],
    );
    if (!user || user.status !== 'active') return next();
    let stationId = payload.sid;
    if (user.role === 'platform_owner') stationId = null;
    else if (stationId !== user.station_id) {
      const link = await one('SELECT 1 AS ok FROM admin_station_links WHERE user_id = $1 AND station_id = $2', [user.id, stationId]);
      if (!link) stationId = user.station_id;
    }
    if (user.role !== 'platform_owner') {
      const st = await one('SELECT active FROM stations WHERE id = $1', [stationId]);
      if (!st || !st.active) { req.stationPaused = true; return next(); }
    }
    req.user = { ...user, home_station_id: user.station_id, station_id: stationId };
    req.stationId = stationId;
    next();
  } catch (err) { next(err); }
}

export const requireAuth = (req, _res, next) => {
  if (req.stationPaused) return next(new HttpError(403, 'This station is paused. Please contact StationDesk.'));
  return req.user ? next() : next(new HttpError(401, 'Please log in'));
};

export const requireRole = (...roles) => (req, _res, next) => {
  if (req.stationPaused) return next(new HttpError(403, 'This station is paused. Please contact StationDesk.'));
  if (!req.user) return next(new HttpError(401, 'Please log in'));
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

// Staff-side routes: admins can do everything staff can
export const staffOrAdmin = requireRole('staff', 'admin');
export const adminOnly = requireRole('admin');
export const platformOnly = requireRole('platform_owner');
