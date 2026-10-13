import { Router } from 'express';
import { one, many, q, tx } from '../db.js';
import { z, parse, wrap, bad, optStr } from '../utils/http.js';
import { requireAuth, adminOnly } from '../middleware/auth.js';
import { upload, fileUrl } from '../services/uploads.js';
import { applyTemplate, TEMPLATES } from '../services/templates.js';
import { audit } from '../utils/audit.js';

const router = Router();
router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  res.json(await one('SELECT * FROM stations WHERE id = $1', [req.stationId]));
}));

router.patch('/', adminOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2), brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    address: optStr, phone: optStr, email: optStr,
    ordering_enabled: z.boolean(), public_prices: z.boolean(), signup_open: z.boolean(), customer_approval: z.boolean(),
    delivery_enabled: z.boolean(), delivery_note: optStr,
    shift_alert_hours: z.coerce.number().int().min(1).max(72),
    cash_tolerance_pct: z.coerce.number().min(0).max(20), litre_tolerance_pct: z.coerce.number().min(0).max(20),
    summary_enabled: z.boolean(), summary_hour: z.coerce.number().int().min(0).max(23), summary_email: optStr,
    loyalty_enabled: z.boolean(), loyalty_points_per_1000: z.coerce.number().int().min(0).max(1000),
    timezone: z.string().min(3),
  }).partial(), req.body);
  if (body.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw bad('Unknown time zone'); }
  }
  const before = await one('SELECT * FROM stations WHERE id = $1', [req.stationId]);
  const sets = [], vals = [];
  Object.entries(body).forEach(([k, v]) => { vals.push(v); sets.push(`${k} = $${vals.length}`); });
  if (!sets.length) throw bad('Nothing to change');
  vals.push(req.stationId);
  const row = await one(`UPDATE stations SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  await audit(req, 'station_settings', 'station', req.stationId, before, body);
  res.json(row);
}));

router.post('/logo', adminOnly, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Choose an image to upload');
  const url = fileUrl(req.file);
  await q('UPDATE stations SET logo_url = $1 WHERE id = $2', [url, req.stationId]);
  res.json({ logo_url: url });
}));

router.get('/setup-status', adminOnly, wrap(async (req, res) => {
  const n = await one(
    `SELECT (SELECT COUNT(*)::int FROM products WHERE station_id = $1) AS products,
            (SELECT COUNT(*)::int FROM pumps WHERE station_id = $1) AS pumps,
            (SELECT COUNT(*)::int FROM categories WHERE station_id = $1) AS categories`, [req.stationId]);
  res.json({ ...n, needs_setup: n.categories === 0, templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label })) });
}));

// Quick setup wizard: categories for the chosen template plus fuels, tanks and pumps
router.post('/setup', adminOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    template: z.enum(['fuel', 'fuel_lube', 'fuel_shop', 'full']),
    fuels: z.array(z.object({
      key: z.enum(['pms', 'ago', 'dpk']), price: z.coerce.number().min(0),
      reorder_level: z.coerce.number().min(0).optional(),
      tanks: z.array(z.object({ name: z.string().min(1), capacity: z.coerce.number().min(0), litres: z.coerce.number().min(0) })).default([]),
      pumps: z.array(z.object({ name: z.string().min(1), reading: z.coerce.number().min(0), tank: z.coerce.number().int().min(0).default(0) })).default([]),
    })).default([]),
  }), req.body);
  const dupe = await one(
    "SELECT 1 AS x FROM products WHERE station_id = $1 AND sale_type = 'metered' AND sku = ANY($2)",
    [req.stationId, body.fuels.map((f) => f.key.toUpperCase())]);
  if (dupe) throw bad('One of those fuels already exists. Edit it from Products and Pumps instead.');
  const created = await tx((client) => applyTemplate(client, req, body));
  res.status(201).json({ created });
}));

export default router;
