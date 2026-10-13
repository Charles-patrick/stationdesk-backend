import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, q } from '../db.js';
import { z, parse, wrap, bad, HttpError, optStr } from '../utils/http.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { config } from '../config.js';

const router = Router();

// Very small login throttle: 8 failed attempts per 15 minutes per IP + username
const fails = new Map();
const throttleKey = (req, u) => `${req.ip}|${u}`;
function checkThrottle(req, u) {
  const rec = fails.get(throttleKey(req, u));
  if (rec && rec.count >= 8 && Date.now() - rec.first < 15 * 60 * 1000) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
function recordFail(req, u) {
  const k = throttleKey(req, u);
  const rec = fails.get(k);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) fails.set(k, { count: 1, first: Date.now() });
  else rec.count += 1;
}

const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, username: u.username, email: u.email, phone: u.phone,
  station_id: u.station_id, loyalty_points: u.loyalty_points,
});

export async function stationBySlug(slug) {
  const s = await one('SELECT * FROM stations WHERE slug = $1', [String(slug || '').toLowerCase()]);
  if (!s || !s.active) throw new HttpError(404, 'We could not find that station');
  return s;
}

router.post('/login', wrap(async (req, res) => {
  const body = parse(z.object({
    slug: z.string().min(1), username: z.string().min(1), password: z.string().optional(), pin: z.string().optional(),
  }), req.body);
  const station = await stationBySlug(body.slug);
  const username = body.username.trim().toLowerCase();
  checkThrottle(req, username);
  let user = await one('SELECT * FROM users WHERE station_id = $1 AND username = $2', [station.id, username]);
  if (!user) {
    user = await one(
      `SELECT u.* FROM users u JOIN admin_station_links l ON l.user_id = u.id WHERE l.station_id = $1 AND u.username = $2`,
      [station.id, username]);
  }
  let ok = false;
  if (user) {
    if (body.password) ok = await bcrypt.compare(body.password, user.password_hash);
    else if (body.pin && user.pin_hash && user.role === 'staff') ok = await bcrypt.compare(body.pin, user.pin_hash);
  }
  if (!ok) { recordFail(req, username); throw new HttpError(401, 'Wrong username or password'); }
  if (user.status === 'pending') throw new HttpError(403, 'Your account is waiting for approval from the station');
  if (user.status === 'blocked') throw new HttpError(403, 'This account has been turned off. Contact the station.');
  await q('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user, station.id), user: publicUser({ ...user, station_id: station.id }) });
}));

router.post('/platform-login', wrap(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  const username = body.username.trim().toLowerCase();
  checkThrottle(req, username);
  const user = await one("SELECT * FROM users WHERE role = 'platform_owner' AND username = $1", [username]);
  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    recordFail(req, username);
    throw new HttpError(401, 'Wrong username or password');
  }
  res.json({ token: signToken(user, null), user: publicUser(user) });
}));

router.post('/register', wrap(async (req, res) => {
  const body = parse(z.object({
    slug: z.string().min(1), name: z.string().trim().min(2), email: z.string().trim().email(),
    phone: optStr, company: optStr, password: z.string().min(6, 'Use at least 6 characters'),
  }), req.body);
  const station = await stationBySlug(body.slug);
  if (!station.ordering_enabled) throw bad('This station is not taking online accounts');
  if (!station.signup_open) throw bad('Sign-up is closed for this station. Ask the station to create your account.');
  const username = body.email.toLowerCase();
  const exists = await one('SELECT 1 AS x FROM users WHERE station_id = $1 AND username = $2', [station.id, username]);
  if (exists) throw bad('An account with this email already exists. Try logging in.');
  const status = station.customer_approval ? 'pending' : 'active';
  const hash = await bcrypt.hash(body.password, 10);
  const user = await one(
    `INSERT INTO users (station_id, role, name, username, email, phone, company, password_hash, status)
     VALUES ($1,'customer',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [station.id, body.name, username, username, body.phone, body.company, hash, status]);
  if (status === 'pending') {
    await notify({ stationId: station.id, role: 'admin', type: 'customer_pending', title: `New customer waiting: ${body.name}`, body: body.email, link: '/admin/customers' });
    return res.status(201).json({ pending: true, message: 'Account created. The station will approve it shortly.' });
  }
  res.status(201).json({ token: signToken(user, station.id), user: publicUser(user) });
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  let station = null;
  let stations = [];
  if (u.role !== 'platform_owner') {
    station = await one('SELECT * FROM stations WHERE id = $1', [req.stationId]);
    if (u.role === 'admin') {
      stations = await many(
        `SELECT s.id, s.slug, s.name FROM stations s
          WHERE s.id = $1 OR s.id IN (SELECT station_id FROM admin_station_links WHERE user_id = $2) ORDER BY s.name`,
        [u.home_station_id, u.id]);
    }
  }
  const unread = await one('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT read', [u.id]);
  const shift = u.role === 'staff' || u.role === 'admin'
    ? await one("SELECT id, started_at FROM shifts WHERE user_id = $1 AND status = 'open'", [u.id]) : null;
  res.json({ user: publicUser({ ...u, station_id: req.stationId }), station, stations, unread: unread.n, open_shift: shift });
}));

router.post('/switch-station', requireAuth, wrap(async (req, res) => {
  const { station_id } = parse(z.object({ station_id: z.coerce.number() }), req.body);
  const u = req.user;
  const allowed = station_id === u.home_station_id
    || await one('SELECT 1 AS x FROM admin_station_links WHERE user_id = $1 AND station_id = $2', [u.id, station_id]);
  if (!allowed) throw new HttpError(403, 'You do not manage that station');
  const s = await one('SELECT id, slug, name FROM stations WHERE id = $1', [station_id]);
  res.json({ token: signToken(u, station_id), station: s });
}));

router.post('/change-password', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({ current: z.string().min(1), next: z.string().min(6, 'Use at least 6 characters') }), req.body);
  const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(body.current, user.password_hash))) throw bad('Your current password is not right');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(body.next, 10), user.id]);
  await audit(req, 'password_change', 'user', user.id);
  res.json({ ok: true });
}));

router.post('/set-pin', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits') }), req.body);
  if (req.user.role !== 'staff') throw bad('PIN login is for staff accounts');
  await q('UPDATE users SET pin_hash = $1 WHERE id = $2', [await bcrypt.hash(body.pin, 10), req.user.id]);
  res.json({ ok: true });
}));

export default router;
