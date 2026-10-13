import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, q } from '../db.js';
import { z, parse, wrap, bad, notFound, optStr } from '../utils/http.js';
import { requireAuth, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';

const router = Router();
router.use(requireAuth, adminOnly);

router.get('/', wrap(async (req, res) => {
  const roles = (req.query.role ? String(req.query.role) : 'staff,admin').split(',');
  const rows = await many(
    `SELECT u.id, u.name, u.username, u.email, u.phone, u.company, u.role, u.status, u.loyalty_points, u.last_login, u.created_at,
        (u.pin_hash IS NOT NULL) AS has_pin,
        (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = u.id) AS orders,
        (SELECT id FROM shifts s WHERE s.user_id = u.id AND s.status = 'open' LIMIT 1) AS open_shift_id
       FROM users u WHERE u.station_id = $1 AND u.role = ANY($2) ORDER BY u.role, u.name`, [req.stationId, roles]);
  res.json(rows);
}));

router.post('/', wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2), username: z.string().trim().toLowerCase().min(3).regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dots, dashes'),
    role: z.enum(['staff', 'admin']), password: z.string().min(6), pin: z.string().regex(/^\d{4,6}$/).optional(),
    email: optStr, phone: optStr,
  }), req.body);
  const row = await one(
    `INSERT INTO users (station_id, role, name, username, email, phone, password_hash, pin_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, username, role, status`,
    [req.stationId, b.role, b.name, b.username, b.email, b.phone, await bcrypt.hash(b.password, 10), b.pin ? await bcrypt.hash(b.pin, 10) : null]);
  await audit(req, 'user_create', 'user', row.id, null, { name: b.name, role: b.role });
  res.status(201).json(row);
}));

router.patch('/:id', wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).optional(), email: optStr.optional(), phone: optStr.optional(),
    status: z.enum(['active', 'pending', 'blocked']).optional(),
    password: z.string().min(6).optional(), pin: z.string().regex(/^\d{4,6}$/).optional(), role: z.enum(['staff', 'admin']).optional(),
  }), req.body);
  const user = await one('SELECT * FROM users WHERE id = $1 AND station_id = $2', [req.params.id, req.stationId]);
  if (!user) throw notFound('User not found');
  if (user.id === req.user.id && (b.status === 'blocked' || b.role === 'staff')) throw bad('You cannot turn off your own account');
  if (b.status === 'blocked') {
    const open = await one("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [user.id]);
    if (open) throw bad('This person has an open shift. Close it first, then turn the account off.');
  }
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const k of ['name', 'email', 'phone', 'status', 'role']) if (b[k] !== undefined) add(k, b[k]);
  if (b.password) add('password_hash', await bcrypt.hash(b.password, 10));
  if (b.pin) add('pin_hash', await bcrypt.hash(b.pin, 10));
  if (!sets.length) throw bad('Nothing to change');
  vals.push(user.id);
  await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  await audit(req, 'user_update', 'user', user.id, { status: user.status, role: user.role }, { ...b, password: b.password ? '(changed)' : undefined, pin: b.pin ? '(changed)' : undefined });
  if (user.status === 'pending' && b.status === 'active') {
    await notify({ stationId: req.stationId, userIds: [user.id], type: 'account', title: 'Your account is approved', body: 'You can now log in and place orders.', link: '/shop' });
  }
  res.json({ ok: true });
}));

export default router;
