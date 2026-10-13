import { Router } from 'express';
import { one, many } from '../db.js';
import { z, parse, wrap, bad } from '../utils/http.js';
import { requireAuth, adminOnly } from '../middleware/auth.js';
import { todayRange } from '../utils/time.js';
import { getRecap, recapPdf, recapXlsx } from '../services/recap.js';
import { stockStatus } from '../utils/stock.js';

const router = Router();
router.use(requireAuth, adminOnly);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function stationOf(req) {
  return one('SELECT * FROM stations WHERE id = $1', [req.stationId]);
}

async function stationSnapshot(stationId, tz) {
  const { start, end } = todayRange(tz);
  const today = await one(
    `SELECT COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(qty) FILTER (WHERE source = 'pump'),0) AS litres
       FROM sales WHERE station_id = $1 AND NOT voided AND created_at >= $2 AND created_at < $3`, [stationId, start, end]);
  const open = await one("SELECT COUNT(*)::int AS n FROM shifts WHERE station_id = $1 AND status = 'open'", [stationId]);
  const low = await one(
    "SELECT COUNT(*)::int AS n FROM products WHERE station_id = $1 AND active AND reorder_level > 0 AND stock_qty <= reorder_level", [stationId]);
  const pending = await one("SELECT COUNT(*)::int AS n FROM orders WHERE station_id = $1 AND status = 'pending'", [stationId]);
  const flagged = await one(
    "SELECT COUNT(*)::int AS n FROM shifts WHERE station_id = $1 AND status = 'closed' AND closed_at > now() - interval '7 days' AND jsonb_array_length(flags) > 0", [stationId]);
  return { today_sales: today.revenue, today_litres: today.litres, open_shifts: open.n, low_stock: low.n, pending_orders: pending.n, flagged_shifts: flagged.n };
}

router.get('/dashboard', wrap(async (req, res) => {
  const st = await stationOf(req);
  const { start, end } = todayRange(st.timezone);
  const snapshot = await stationSnapshot(st.id, st.timezone);
  const byProduct = await many(
    `SELECT product_name AS name, SUM(qty) AS qty, SUM(amount) AS amount FROM sales
      WHERE station_id = $1 AND NOT voided AND created_at >= $2 AND created_at < $3 GROUP BY product_name ORDER BY amount DESC LIMIT 6`, [st.id, start, end]);
  const trend = await many(
    `SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date, SUM(amount) AS revenue FROM sales
      WHERE station_id = $1 AND NOT voided AND created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`, [st.id, st.timezone]);
  const expenses = await one('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE station_id = $1 AND NOT voided AND created_at >= $2 AND created_at < $3', [st.id, start, end]);
  const openShifts = await many(
    `SELECT s.id, s.started_at, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.station_id = $1 AND s.status = 'open' ORDER BY s.started_at`, [st.id]);
  const lowStock = await many(
    `SELECT id, name, variant, stock_qty, reorder_level, unit FROM products WHERE station_id = $1 AND active AND reorder_level > 0 AND stock_qty <= reorder_level ORDER BY stock_qty LIMIT 12`, [st.id]);
  const flagged = await many(
    `SELECT s.id, s.closed_at, s.variance_amount, s.flags, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.station_id = $1 AND s.status = 'closed' AND jsonb_array_length(s.flags) > 0 ORDER BY s.closed_at DESC LIMIT 6`, [st.id]);
  const approvals = await one("SELECT COUNT(*)::int AS n FROM edit_requests WHERE station_id = $1 AND status = 'pending'", [st.id]);
  const owed = await one(`SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN -amount ELSE amount END),0) AS total FROM credit_entries WHERE station_id = $1 AND NOT voided`, [st.id]);
  const tanks = await many(
    `SELECT t.id, t.name, t.capacity_litres, t.current_litres, p.name AS product_name FROM tanks t JOIN products p ON p.id = t.product_id WHERE t.station_id = $1 AND t.active ORDER BY p.name, t.name`, [st.id]);
  res.json({ ...snapshot, today_expenses: expenses.total, top_today: byProduct, trend, open_shift_list: openShifts, low_stock_list: lowStock,
    flagged_list: flagged, pending_approvals: approvals.n, credit_owed: owed.total, tanks });
}));

router.get('/sales', wrap(async (req, res) => {
  const q = parse(z.object({
    from: z.string().optional(), to: z.string().optional(),
    by: z.enum(['day', 'product', 'category', 'pump', 'staff', 'payment', 'source']).default('day'),
  }), req.query);
  const st = await stationOf(req);
  const col = {
    day: "to_char(s.created_at AT TIME ZONE $4, 'YYYY-MM-DD')", product: 's.product_name', category: "COALESCE(c.name,'Other')",
    pump: "COALESCE(pu.name,'Not from a pump')", staff: "COALESCE(u.name,'Unknown')", payment: 's.payment', source: 's.source',
  }[q.by];
  const rows = await many(
    `SELECT ${col} AS label, SUM(s.qty) AS qty, SUM(s.amount) AS amount, COUNT(*)::int AS lines
       FROM sales s JOIN products p ON p.id = s.product_id LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN pumps pu ON pu.id = s.pump_id LEFT JOIN users u ON u.id = s.entered_by
      WHERE s.station_id = $1 AND NOT s.voided AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3)
      GROUP BY 1 ORDER BY ${q.by === 'day' ? '1' : 'amount DESC'}`,
    [req.stationId, q.from || null, q.to || null, st.timezone]);
  res.json(rows);
}));

router.get('/months', wrap(async (req, res) => {
  const st = await stationOf(req);
  const rows = await many(
    `SELECT DISTINCT to_char(created_at AT TIME ZONE $2, 'YYYY-MM') AS month FROM sales WHERE station_id = $1 ORDER BY 1 DESC`, [req.stationId, st.timezone]);
  const cur = await one("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM') AS m", [st.timezone]);
  const months = new Set(rows.map((r) => r.month));
  months.add(cur.m);
  res.json([...months].sort().reverse());
}));

router.get('/monthly/:month', wrap(async (req, res) => {
  if (!MONTH.test(req.params.month)) throw bad('Use the format YYYY-MM');
  const st = await stationOf(req);
  const nowKey = (await one("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM') AS m", [st.timezone])).m;
  // The running month is always rebuilt so it stays live. Past months are saved when first viewed.
  res.json(await getRecap(req.stationId, req.params.month, { refresh: req.query.refresh === '1' || req.params.month === nowKey }));
}));

router.get('/monthly/:month/pdf', wrap(async (req, res) => {
  if (!MONTH.test(req.params.month)) throw bad('Use the format YYYY-MM');
  const data = await getRecap(req.stationId, req.params.month, { refresh: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="recap-${req.params.month}.pdf"`);
  res.send(await recapPdf(data));
}));

router.get('/monthly/:month/xlsx', wrap(async (req, res) => {
  if (!MONTH.test(req.params.month)) throw bad('Use the format YYYY-MM');
  const data = await getRecap(req.stationId, req.params.month, { refresh: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="recap-${req.params.month}.xlsx"`);
  res.send(await recapXlsx(data));
}));

// How long each product will last at the current sales pace, and what to order
router.get('/reorder-suggestions', wrap(async (req, res) => {
  const rows = await many(
    `SELECT p.id, p.name, p.variant, p.unit, p.stock_qty, p.reorder_level, p.sale_type,
        COALESCE((SELECT SUM(s.qty) FROM sales s WHERE s.product_id = p.id AND NOT s.voided AND s.created_at > now() - interval '14 days'), 0) / 14.0 AS daily_rate
       FROM products p WHERE p.station_id = $1 AND p.active AND p.sale_type <> 'service' ORDER BY p.name`, [req.stationId]);
  const out = rows.map((r) => {
    const rate = Number(r.daily_rate);
    const daysLeft = rate > 0 ? Math.round((Number(r.stock_qty) / rate) * 10) / 10 : null;
    const suggested = rate > 0 ? Math.max(0, Math.ceil(rate * 14 - Number(r.stock_qty))) : 0;
    return { ...r, daily_rate: Math.round(rate * 100) / 100, days_left: daysLeft, suggested_qty: suggested, stock_status: stockStatus(r) };
  }).filter((r) => r.daily_rate > 0 || r.stock_status !== 'in_stock')
    .sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999));
  res.json(out);
}));

// Owners with several stations: one view across every station they manage
router.get('/multi-station', wrap(async (req, res) => {
  const stations = await many(
    `SELECT s.* FROM stations s WHERE s.id = $1 OR s.id IN (SELECT station_id FROM admin_station_links WHERE user_id = $2) ORDER BY s.name`,
    [req.user.home_station_id, req.user.id]);
  const out = [];
  for (const s of stations) out.push({ id: s.id, slug: s.slug, name: s.name, ...(await stationSnapshot(s.id, s.timezone)) });
  res.json(out);
}));

export default router;
