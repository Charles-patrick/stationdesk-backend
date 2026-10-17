import { Router } from 'express';
import { one, many, tx, pool } from '../db.js';
import { z, parse, wrap, bad, notFound, forbidden, id } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { startShift, closeShift, pendingReadings, recordPriceReadings } from '../services/shifts.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

async function shiftDetail(shiftId, stationId) {
  const shift = await one(
    `SELECT s.*, u.name AS user_name, cb.name AS closed_by_name FROM shifts s JOIN users u ON u.id = s.user_id
       LEFT JOIN users cb ON cb.id = s.closed_by WHERE s.id = $1 AND s.station_id = $2`, [shiftId, stationId]);
  if (!shift) return null;
  shift.pumps = await many(
    `SELECT sp.*, pu.name AS pump_name, pu.meter_max, p.name AS product_name,
        COALESCE((SELECT json_agg(json_build_object('price_history_id', r.price_history_id, 'reading', r.reading, 'old_price', ph.old_price, 'new_price', ph.price, 'at', ph.effective_at) ORDER BY ph.effective_at)
                    FROM pump_price_readings r JOIN price_history ph ON ph.id = r.price_history_id WHERE r.shift_pump_id = sp.id), '[]') AS price_readings
       FROM shift_pumps sp JOIN pumps pu ON pu.id = sp.pump_id JOIN products p ON p.id = pu.product_id WHERE sp.shift_id = $1 ORDER BY pu.name`, [shift.id]);
  shift.sales = await many(
    `SELECT sa.*, u.name AS entered_by_name FROM sales sa LEFT JOIN users u ON u.id = sa.entered_by WHERE sa.shift_id = $1 ORDER BY sa.created_at`, [shift.id]);
  shift.dips = await many(
    'SELECT d.*, t.name AS tank_name FROM dip_readings d JOIN tanks t ON t.id = d.tank_id WHERE d.shift_id = $1', [shift.id]);
  shift.expenses = await many('SELECT * FROM expenses WHERE shift_id = $1 AND NOT voided ORDER BY created_at', [shift.id]);
  return shift;
}

router.get('/available-pumps', wrap(async (req, res) => {
  res.json(await many(
    `SELECT pu.id, pu.name, pu.current_reading, p.name AS product_name,
        (SELECT u.name FROM shift_pumps sp JOIN shifts s ON s.id = sp.shift_id AND s.status = 'open' JOIN users u ON u.id = s.user_id
          WHERE sp.pump_id = pu.id LIMIT 1) AS taken_by
       FROM pumps pu JOIN products p ON p.id = pu.product_id WHERE pu.station_id = $1 AND pu.active ORDER BY p.name, pu.name`, [req.stationId]));
}));

router.get('/current', wrap(async (req, res) => {
  const open = await one("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id]);
  if (!open) return res.json(null);
  const shift = await shiftDetail(open.id, req.stationId);
  shift.pending_readings = await pendingReadings(pool, shift.id);
  const live = await one(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE NOT voided),0) AS total_sales FROM sales WHERE shift_id = $1`, [shift.id]);
  shift.running_sales = live.total_sales;
  res.json(shift);
}));

router.post('/start', wrap(async (req, res) => {
  const b = parse(z.object({
    pumps: z.array(z.object({ pump_id: id, opening_reading: z.coerce.number().min(0).optional().nullable() })).default([]),
  }), req.body);
  const shift = await tx((client) => startShift(client, req, b.pumps));
  res.status(201).json(shift);
}));

router.post('/:id/price-readings', wrap(async (req, res) => {
  const b = parse(z.object({ readings: z.array(z.object({ shift_pump_id: id, price_history_id: id, reading: z.coerce.number().min(0) })).min(1) }), req.body);
  await tx(async (client) => {
    const { rows: [shift] } = await client.query("SELECT * FROM shifts WHERE id = $1 AND station_id = $2 AND status = 'open'", [req.params.id, req.stationId]);
    if (!shift) throw notFound('Open shift not found');
    if (shift.user_id !== req.user.id && req.user.role !== 'admin') throw forbidden();
    await recordPriceReadings(client, req, shift, b.readings);
  });
  res.json({ ok: true });
}));

const closeSchema = z.object({
  pumps: z.array(z.object({ shift_pump_id: id, closing_reading: z.coerce.number().min(0), rollover: z.boolean().optional() })).default([]),
  dips: z.array(z.object({ tank_id: id, litres: z.union([z.literal(''), z.coerce.number().min(0)]).optional().nullable() })).default([]),
  price_readings: z.array(z.object({ shift_pump_id: id, price_history_id: id, reading: z.coerce.number().min(0) })).optional(),
  cash: z.coerce.number().min(0).default(0), transfer: z.coerce.number().min(0).default(0), pos: z.coerce.number().min(0).default(0),
  note: z.string().trim().optional().nullable(),
});

router.post('/:id/close', wrap(async (req, res) => {
  const b = parse(closeSchema, req.body);
  res.json(await tx((client) => closeShift(client, req, Number(req.params.id), b)));
}));

router.post('/:id/admin-close', adminOnly, wrap(async (req, res) => {
  const b = parse(closeSchema, req.body);
  res.json(await tx((client) => closeShift(client, req, Number(req.params.id), b, { adminClose: true })));
}));

router.get('/', wrap(async (req, res) => {
  const mine = req.user.role === 'staff';
  const { from, to, user_id, status, flagged } = req.query;
  const rows = await many(
    `SELECT s.id, s.status, s.started_at, s.closed_at, s.admin_closed, s.expected_amount, s.variance_amount, s.flags,
            s.cash_declared + s.transfer_declared + s.pos_declared AS declared, s.pump_sales, s.manual_sales, s.credit_sales,
            u.name AS user_name, u.id AS user_id
       FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.station_id = $1 AND ($2::boolean IS NOT TRUE OR s.user_id = $3)
        AND ($4::timestamptz IS NULL OR s.started_at >= $4) AND ($5::timestamptz IS NULL OR s.started_at < $5)
        AND ($6::bigint IS NULL OR s.user_id = $6) AND ($7::text IS NULL OR s.status = $7)
        AND ($8::boolean IS NOT TRUE OR jsonb_array_length(s.flags) > 0)
      ORDER BY s.started_at DESC LIMIT 200`,
    [req.stationId, mine, req.user.id, from || null, to || null, user_id || null, status || null, flagged === '1']);
  res.json(rows);
}));

router.get('/:id', wrap(async (req, res) => {
  const shift = await shiftDetail(req.params.id, req.stationId);
  if (!shift) throw notFound('Shift not found');
  if (req.user.role === 'staff' && shift.user_id !== req.user.id) throw forbidden();
  res.json(shift);
}));

export default router;
