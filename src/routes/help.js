import { Router } from 'express';
import { one, many, q, pool } from '../db.js';
import { z, parse, wrap, notFound, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { copyDefaultHelp } from '../services/help.js';
import { audit } from '../utils/audit.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

// Each person sees only the guides written for their role
router.get('/', wrap(async (req, res) => {
  res.json(await many(
    'SELECT id, audience, title, body, video_url, sort FROM station_help WHERE station_id = $1 AND audience = $2 AND published ORDER BY sort, id',
    [req.stationId, req.user.role]));
}));

// Admins manage every guide for their station
router.get('/manage', adminOnly, wrap(async (req, res) => {
  res.json(await many('SELECT * FROM station_help WHERE station_id = $1 ORDER BY audience, sort, id', [req.stationId]));
}));

const schema = z.object({
  audience: z.enum(['customer', 'staff', 'admin']), title: z.string().trim().min(2), body: z.string().min(2),
  video_url: optStr, sort: z.coerce.number().int().default(0), published: z.boolean().default(true),
});

router.post('/manage', adminOnly, wrap(async (req, res) => {
  const b = parse(schema, req.body);
  const row = await one(
    'INSERT INTO station_help (station_id, audience, title, body, video_url, sort, published) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.stationId, b.audience, b.title, b.body, b.video_url, b.sort, b.published]);
  await audit(req, 'help_create', 'help', row.id, null, { title: b.title, audience: b.audience });
  res.status(201).json(row);
}));

router.put('/manage/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(schema, req.body);
  const row = await one(
    'UPDATE station_help SET audience=$1, title=$2, body=$3, video_url=$4, sort=$5, published=$6 WHERE id=$7 AND station_id=$8 RETURNING *',
    [b.audience, b.title, b.body, b.video_url, b.sort, b.published, req.params.id, req.stationId]);
  if (!row) throw notFound();
  await audit(req, 'help_update', 'help', row.id, null, { title: b.title });
  res.json(row);
}));

router.delete('/manage/:id', adminOnly, wrap(async (req, res) => {
  const row = await one('DELETE FROM station_help WHERE id = $1 AND station_id = $2 RETURNING id, title', [req.params.id, req.stationId]);
  if (!row) throw notFound();
  await audit(req, 'help_delete', 'help', row.id, { title: row.title }, null);
  res.json({ ok: true });
}));

// Bring back any default guide that was deleted. Guides you edited are left alone.
router.post('/manage/restore-defaults', adminOnly, wrap(async (req, res) => {
  // overwrite: true replaces every standard guide with the latest default text. Guides you wrote yourself are kept.
  if (req.body?.overwrite === true) {
    await q('DELETE FROM station_help WHERE station_id = $1 AND source_slug IS NOT NULL', [req.stationId]);
    await audit(req, 'help_reset', 'help', null, null, { overwrite: true });
  }
  const before = await one('SELECT COUNT(*)::int AS n FROM station_help WHERE station_id = $1', [req.stationId]);
  await copyDefaultHelp(pool, req.stationId);
  const after = await one('SELECT COUNT(*)::int AS n FROM station_help WHERE station_id = $1', [req.stationId]);
  res.json({ restored: after.n - before.n });
}));

export default router;
