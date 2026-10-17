import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, q, tx } from '../db.js';
import { z, parse, wrap, bad, HttpError, optStr } from '../utils/http.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { sendEmail } from '../services/email.js';
import { upload, fileUrl } from '../services/uploads.js';
import { copyDefaultHelp } from '../services/help.js';
import { config } from '../config.js';

const router = Router();

// Small in-memory throttles. They reset when the server restarts, which is fine for this purpose.
const buckets = new Map();
function throttle(key, max, windowMs, message) {
  const now = Date.now();
  const rec = buckets.get(key);
  if (!rec || now - rec.first > windowMs) { buckets.set(key, { count: 1, first: now }); return; }
  rec.count += 1;
  if (rec.count > max) throw new HttpError(429, message || 'Too many attempts. Try again in a few minutes.');
}
const failKey = (req, u) => `login|${req.ip}|${u}`;
function checkFails(req, u) {
  const rec = buckets.get(failKey(req, u));
  if (rec && rec.count >= 8 && Date.now() - rec.first < 15 * 60 * 1000) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
function recordFail(req, u) {
  const k = failKey(req, u);
  const rec = buckets.get(k);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) buckets.set(k, { count: 1, first: Date.now() });
  else rec.count += 1;
}
export { throttle };

const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.name, username: u.username, email: u.email, phone: u.phone, station_id: u.station_id,
});

const RESERVED = new Set(['login', 'signup', 'platform', 'admin', 'api', 's', 'help', 'www', 'app', 'staff', 'demo-station']);

export async function stationBySlug(slug, { allowInactive = false } = {}) {
  const s = await one('SELECT * FROM stations WHERE slug = $1', [String(slug || '').toLowerCase()]);
  if (!s || (!s.active && !allowInactive)) throw new HttpError(404, 'We could not find that station');
  return s;
}

function stationBlock(s) {
  if (s.pending) return new HttpError(403, 'Your station is waiting for approval. You will be able to log in once it is approved.');
  if (!s.active) return new HttpError(403, 'This station is paused. Please contact StationDesk.');
  return null;
}

// Owners and admins log in with email and password. No station code needed.
router.post('/login', wrap(async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().min(1), password: z.string().min(1) }), req.body);
  const id = body.email.toLowerCase();
  checkFails(req, id);
  const candidates = await many(
    "SELECT * FROM users WHERE role = 'admin' AND (lower(email) = $1 OR username = $1) ORDER BY id", [id]);
  let user = null;
  for (const c of candidates) if (await bcrypt.compare(body.password, c.password_hash)) { user = c; break; }
  if (!user) { recordFail(req, id); throw new HttpError(401, 'Wrong email or password'); }
  if (user.status === 'blocked') throw new HttpError(403, 'This account has been turned off.');
  const station = await one('SELECT * FROM stations WHERE id = $1', [user.station_id]);
  const block = stationBlock(station);
  if (block) throw block;
  await q('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user, station.id), user: publicUser(user), station: { id: station.id, slug: station.slug, name: station.name } });
}));

// Attendants log in with their station code, username and password or PIN
router.post('/staff-login', wrap(async (req, res) => {
  const body = parse(z.object({
    slug: z.string().trim().min(1), username: z.string().trim().min(1), password: z.string().optional(), pin: z.string().optional(),
  }), req.body);
  const username = body.username.toLowerCase();
  checkFails(req, `${body.slug}|${username}`);
  const station = await one('SELECT * FROM stations WHERE slug = $1', [body.slug.toLowerCase()]);
  if (!station) { recordFail(req, `${body.slug}|${username}`); throw new HttpError(401, 'Check the station code, username and password'); }
  const user = await one("SELECT * FROM users WHERE station_id = $1 AND username = $2 AND role = 'staff'", [station.id, username]);
  let ok = false;
  if (user) {
    if (body.password) ok = await bcrypt.compare(body.password, user.password_hash);
    else if (body.pin && user.pin_hash) ok = await bcrypt.compare(body.pin, user.pin_hash);
  }
  if (!ok) { recordFail(req, `${body.slug}|${username}`); throw new HttpError(401, 'Check the station code, username and password'); }
  if (user.status !== 'active') throw new HttpError(403, 'This account has been turned off. Contact your manager.');
  const block = stationBlock(station);
  if (block) throw block;
  await q('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user, station.id), user: publicUser(user), station: { id: station.id, slug: station.slug, name: station.name } });
}));

router.post('/platform-login', wrap(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  const username = body.username.trim().toLowerCase();
  checkFails(req, username);
  const user = await one("SELECT * FROM users WHERE role = 'platform_owner' AND username = $1", [username]);
  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    recordFail(req, username);
    throw new HttpError(401, 'Wrong username or password');
  }
  res.json({ token: signToken(user, null), user: publicUser(user) });
}));

router.get('/slug-available', wrap(async (req, res) => {
  const slug = String(req.query.slug || '').toLowerCase();
  const valid = /^[a-z0-9][a-z0-9-]{2,30}$/.test(slug) && !RESERVED.has(slug);
  const taken = valid ? !!(await one('SELECT 1 AS x FROM stations WHERE slug = $1', [slug])) : false;
  res.json({ valid, available: valid && !taken });
}));

// Business owner sign-up. The station waits for the platform owner to approve it.
router.post('/signup', upload.single('logo'), wrap(async (req, res) => {
  throttle(`signup|${req.ip}`, 5, 60 * 60 * 1000, 'Too many sign-ups from this connection. Please try again later.');
  const b = parse(z.object({
    business_name: z.string().trim().min(2), station_code: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,30}$/, 'Use 3 to 31 lowercase letters, numbers or dashes'),
    owner_name: z.string().trim().min(2), email: z.string().trim().toLowerCase().email(), phone: optStr,
    password: z.string().min(8, 'Use at least 8 characters'), address: optStr,
  }), req.body);
  if (RESERVED.has(b.station_code)) throw bad('Please choose a different station code');
  const station = await tx(async (client) => {
    const { rows: [s] } = await client.query(
      `INSERT INTO stations (slug, name, address, phone, email, summary_email, logo_url, active, pending)
       VALUES ($1,$2,$3,$4,$5,$5,$6,FALSE,TRUE) RETURNING *`,
      [b.station_code, b.business_name, b.address, b.phone, b.email, fileUrl(req.file)]);
    await client.query(
      `INSERT INTO users (station_id, role, name, username, email, phone, password_hash) VALUES ($1,'admin',$2,$3,$4,$5,$6)`,
      [s.id, b.owner_name, b.email, b.email, b.phone, await bcrypt.hash(b.password, 10)]);
    await copyDefaultHelp(client, s.id);
    return s;
  });
  const owners = await many("SELECT id FROM users WHERE role = 'platform_owner'");
  await notify({ userIds: owners.map((o) => o.id), type: 'signup', stationId: null, title: `New station waiting: ${b.business_name}`, body: `${b.owner_name}, ${b.email}`, link: null, email: false });
  if (process.env.PLATFORM_OWNER_EMAIL) {
    sendEmail({ to: process.env.PLATFORM_OWNER_EMAIL, subject: `New ${config.appName} sign-up: ${b.business_name}`, text: `${b.owner_name} (${b.email}, ${b.phone || 'no phone'}) signed up ${b.business_name}. Approve it from the platform screen.` });
  }
  sendEmail({ to: b.email, subject: `We received your ${config.appName} sign-up`, text: `Hello ${b.owner_name},\n\nThanks for signing up ${b.business_name}. We will approve your account shortly and you can then log in.\n` });
  res.status(201).json({ ok: true, station: { name: station.name, slug: station.slug } });
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
  const shift = u.role === 'staff' ? await one("SELECT id, started_at FROM shifts WHERE user_id = $1 AND status = 'open'", [u.id]) : null;
  res.json({ user: publicUser({ ...u, station_id: req.stationId }), station, stations, unread: unread.n, open_shift: shift });
}));

router.post('/switch-station', requireAuth, wrap(async (req, res) => {
  const { station_id } = parse(z.object({ station_id: z.coerce.number() }), req.body);
  const u = req.user;
  const allowed = station_id === u.home_station_id
    || await one('SELECT 1 AS x FROM admin_station_links WHERE user_id = $1 AND station_id = $2', [u.id, station_id]);
  if (!allowed) throw new HttpError(403, 'You do not manage that station');
  const s = await one('SELECT id, slug, name, active FROM stations WHERE id = $1', [station_id]);
  if (!s?.active) throw new HttpError(403, 'That station is paused');
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
