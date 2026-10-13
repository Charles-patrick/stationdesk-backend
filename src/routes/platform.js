import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, q, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, id, optStr } from '../utils/http.js';
import { platformOnly } from '../middleware/auth.js';
import { applyTemplate } from '../services/templates.js';
import { audit } from '../utils/audit.js';

const router = Router();
router.use(platformOnly);

const slugRe = /^[a-z0-9][a-z0-9-]{1,40}$/;

router.get('/overview', wrap(async (_req, res) => {
  const stations = await one('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active FROM stations');
  const users = await one("SELECT COUNT(*) FILTER (WHERE role='staff')::int AS staff, COUNT(*) FILTER (WHERE role='customer')::int AS customers, COUNT(*) FILTER (WHERE role='admin')::int AS admins FROM users");
  const open = await one("SELECT COUNT(*)::int AS n FROM shifts WHERE status = 'open'");
  res.json({ stations, users, open_shifts: open.n });
}));

router.get('/stations', wrap(async (_req, res) => {
  res.json(await many(
    `SELECT s.*,
       (SELECT COUNT(*)::int FROM users u WHERE u.station_id = s.id AND u.role IN ('staff','admin')) AS team,
       (SELECT COUNT(*)::int FROM users u WHERE u.station_id = s.id AND u.role = 'customer') AS customers,
       (SELECT COUNT(*)::int FROM products p WHERE p.station_id = s.id AND p.active) AS products,
       (SELECT MAX(created_at) FROM sales x WHERE x.station_id = s.id) AS last_sale
     FROM stations s ORDER BY s.created_at DESC`));
}));

router.post('/stations', wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2),
    slug: z.string().trim().toLowerCase().regex(slugRe, 'Use lowercase letters, numbers and dashes'),
    brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    template: z.enum(['fuel', 'fuel_lube', 'fuel_shop', 'full']).default('full'),
    address: optStr, phone: optStr, email: optStr,
    admin_name: z.string().trim().min(2),
    admin_username: z.string().trim().toLowerCase().min(3),
    admin_password: z.string().min(6),
    admin_email: optStr,
  }), req.body);
  const result = await tx(async (client) => {
    const { rows: [station] } = await client.query(
      `INSERT INTO stations (slug, name, brand_color, address, phone, email, summary_email) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [body.slug, body.name, body.brand_color || '#F2A900', body.address, body.phone, body.email, body.admin_email || body.email]);
    const { rows: [admin] } = await client.query(
      `INSERT INTO users (station_id, role, name, username, email, password_hash) VALUES ($1,'admin',$2,$3,$4,$5) RETURNING id, name, username`,
      [station.id, body.admin_name, body.admin_username, body.admin_email, await bcrypt.hash(body.admin_password, 10)]);
    await applyTemplate(client, { stationId: station.id, user: req.user }, { template: body.template, fuels: [] });
    await audit({ ...req, stationId: station.id }, 'station_create', 'station', station.id, null, { name: station.name }, null, client);
    return { station, admin };
  });
  res.status(201).json(result);
}));

router.patch('/stations/:id', wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).optional(), active: z.boolean().optional(),
    brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    address: optStr.optional(), phone: optStr.optional(),
  }), req.body);
  const sets = [], vals = [];
  Object.entries(body).forEach(([k, v]) => { vals.push(v); sets.push(`${k} = $${vals.length}`); });
  if (!sets.length) throw bad('Nothing to change');
  vals.push(req.params.id);
  const row = await one(`UPDATE stations SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  if (!row) throw notFound();
  res.json(row);
}));

router.get('/stations/:id/team', wrap(async (req, res) => {
  res.json(await many(
    "SELECT id, name, username, role, email, status, last_login FROM users WHERE station_id = $1 AND role IN ('admin','staff') ORDER BY role, name", [req.params.id]));
}));

router.post('/stations/:id/reset-password', wrap(async (req, res) => {
  const body = parse(z.object({ user_id: id, password: z.string().min(6) }), req.body);
  const u = await one('SELECT id FROM users WHERE id = $1 AND station_id = $2', [body.user_id, req.params.id]);
  if (!u) throw notFound('User not found at this station');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(body.password, 10), u.id]);
  res.json({ ok: true });
}));

// Give one admin access to several stations (multi-station owners)
router.post('/link-admin', wrap(async (req, res) => {
  const body = parse(z.object({ user_id: id, station_id: id }), req.body);
  const u = await one("SELECT id, station_id FROM users WHERE id = $1 AND role = 'admin'", [body.user_id]);
  if (!u) throw bad('That user is not a station admin');
  if (u.station_id === body.station_id) throw bad('That is already this admin\'s home station');
  await q('INSERT INTO admin_station_links (user_id, station_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [body.user_id, body.station_id]);
  res.json({ ok: true });
}));

router.delete('/link-admin', wrap(async (req, res) => {
  const body = parse(z.object({ user_id: id, station_id: id }), req.body);
  await q('DELETE FROM admin_station_links WHERE user_id = $1 AND station_id = $2', [body.user_id, body.station_id]);
  res.json({ ok: true });
}));

router.get('/admins', wrap(async (_req, res) => {
  res.json(await many(
    `SELECT u.id, u.name, u.username, s.name AS station,
       COALESCE((SELECT json_agg(json_build_object('id', l.station_id, 'name', s2.name)) FROM admin_station_links l JOIN stations s2 ON s2.id = l.station_id WHERE l.user_id = u.id), '[]') AS linked
     FROM users u JOIN stations s ON s.id = u.station_id WHERE u.role = 'admin' ORDER BY s.name, u.name`));
}));

// Help centre content, managed centrally so one edit reaches every station
router.get('/help', wrap(async (_req, res) => {
  res.json(await many('SELECT * FROM help_articles ORDER BY audience, sort, id'));
}));

const helpSchema = z.object({
  audience: z.enum(['customer', 'staff', 'admin']), title: z.string().trim().min(2), body: z.string().min(2),
  video_url: optStr, sort: z.coerce.number().int().default(0), published: z.boolean().default(true),
});

router.post('/help', wrap(async (req, res) => {
  const b = parse(helpSchema, req.body);
  const slug = `${b.audience}-${b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`;
  res.status(201).json(await one(
    'INSERT INTO help_articles (audience, slug, title, body, video_url, sort, published) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [b.audience, slug, b.title, b.body, b.video_url, b.sort, b.published]));
}));

router.put('/help/:id', wrap(async (req, res) => {
  const b = parse(helpSchema, req.body);
  const row = await one(
    'UPDATE help_articles SET audience=$1, title=$2, body=$3, video_url=$4, sort=$5, published=$6 WHERE id=$7 RETURNING *',
    [b.audience, b.title, b.body, b.video_url, b.sort, b.published, req.params.id]);
  if (!row) throw notFound();
  res.json(row);
}));

router.delete('/help/:id', wrap(async (req, res) => {
  await q('DELETE FROM help_articles WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

export default router;
