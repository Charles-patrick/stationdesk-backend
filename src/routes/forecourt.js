import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, id } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { moveTank } from '../utils/stock.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

router.get('/', wrap(async (req, res) => {
  const tanks = await many(
    `SELECT t.*, p.name AS product_name FROM tanks t JOIN products p ON p.id = t.product_id WHERE t.station_id = $1 ORDER BY p.name, t.name`, [req.stationId]);
  const pumps = await many(
    `SELECT pu.*, p.name AS product_name, t.name AS tank_name,
        (SELECT json_build_object('shift_id', s.id, 'user_id', u.id, 'user_name', u.name)
           FROM shift_pumps sp JOIN shifts s ON s.id = sp.shift_id AND s.status = 'open' JOIN users u ON u.id = s.user_id
          WHERE sp.pump_id = pu.id LIMIT 1) AS on_shift
       FROM pumps pu JOIN products p ON p.id = pu.product_id LEFT JOIN tanks t ON t.id = pu.tank_id
      WHERE pu.station_id = $1 ORDER BY p.name, pu.name`, [req.stationId]);
  res.json({ tanks, pumps });
}));

router.post('/tanks', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ product_id: id, name: z.string().trim().min(1), capacity_litres: z.coerce.number().min(0), litres: z.coerce.number().min(0).default(0) }), req.body);
  const row = await tx(async (client) => {
    const p = (await client.query("SELECT * FROM products WHERE id = $1 AND station_id = $2 AND sale_type = 'metered'", [b.product_id, req.stationId])).rows[0];
    if (!p) throw bad('Choose a fuel product (sold by pump)');
    const { rows: [t] } = await client.query(
      'INSERT INTO tanks (station_id, product_id, name, capacity_litres, current_litres) VALUES ($1,$2,$3,$4,0) RETURNING *',
      [req.stationId, b.product_id, b.name, b.capacity_litres]);
    if (b.litres > 0) await moveTank(client, { stationId: req.stationId, tankId: t.id, delta: b.litres, type: 'opening', note: 'Opening stock', userId: req.user.id });
    await audit(req, 'tank_create', 'tank', t.id, null, b, null, client);
    return t;
  });
  res.status(201).json(row);
}));

router.patch('/tanks/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).optional(), capacity_litres: z.coerce.number().min(0).optional(), active: z.boolean().optional() }), req.body);
  const row = await one(
    'UPDATE tanks SET name = COALESCE($1,name), capacity_litres = COALESCE($2,capacity_litres), active = COALESCE($3,active) WHERE id = $4 AND station_id = $5 RETURNING *',
    [b.name, b.capacity_litres, b.active, req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

router.post('/pumps', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({
    product_id: id, tank_id: id.optional().nullable(), name: z.string().trim().min(1),
    reading: z.coerce.number().min(0).default(0), meter_max: z.coerce.number().positive().default(99999999),
  }), req.body);
  const p = await one("SELECT id FROM products WHERE id = $1 AND station_id = $2 AND sale_type = 'metered'", [b.product_id, req.stationId]);
  if (!p) throw bad('Choose a fuel product (sold by pump)');
  if (b.tank_id) {
    const t = await one('SELECT id FROM tanks WHERE id = $1 AND station_id = $2 AND product_id = $3', [b.tank_id, req.stationId, b.product_id]);
    if (!t) throw bad('That tank does not hold this fuel');
  }
  const row = await one(
    'INSERT INTO pumps (station_id, product_id, tank_id, name, current_reading, meter_max) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.stationId, b.product_id, b.tank_id || null, b.name, b.reading, b.meter_max]);
  await audit(req, 'pump_create', 'pump', row.id, null, b);
  res.status(201).json(row);
}));

router.patch('/pumps/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).optional(), tank_id: id.optional().nullable(), meter_max: z.coerce.number().positive().optional(), active: z.boolean().optional() }), req.body);
  const row = await one(
    `UPDATE pumps SET name = COALESCE($1,name), tank_id = CASE WHEN $2::boolean THEN $3 ELSE tank_id END,
       meter_max = COALESCE($4,meter_max), active = COALESCE($5,active) WHERE id = $6 AND station_id = $7 RETURNING *`,
    [b.name, 'tank_id' in req.body, b.tank_id ?? null, b.meter_max, b.active, req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

// A meter was replaced or reset: set the new starting reading so it is not counted as sales
router.post('/pumps/:id/reset-meter', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ reading: z.coerce.number().min(0), reason: z.string().trim().min(3, 'Say why the meter is being reset') }), req.body);
  const pump = await one('SELECT * FROM pumps WHERE id = $1 AND station_id = $2', [req.params.id, req.stationId]);
  if (!pump) throw notFound();
  const busy = await one("SELECT 1 AS x FROM shift_pumps sp JOIN shifts s ON s.id = sp.shift_id WHERE sp.pump_id = $1 AND s.status = 'open'", [pump.id]);
  if (busy) throw bad('This pump is on an open shift. Close the shift first.');
  await one('UPDATE pumps SET current_reading = $1 WHERE id = $2 RETURNING id', [b.reading, pump.id]);
  await audit(req, 'meter_reset', 'pump', pump.id, { reading: pump.current_reading }, { reading: b.reading }, b.reason);
  res.json({ ok: true });
}));

export default router;
