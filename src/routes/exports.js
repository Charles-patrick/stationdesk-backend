import { Router } from 'express';
import { many } from '../db.js';
import { wrap, bad } from '../utils/http.js';
import { requireAuth, adminOnly } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, adminOnly);

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
};

const ENTITIES = {
  sales: `SELECT s.id, s.created_at, s.product_name, s.qty, s.unit_price, s.amount, s.source, s.payment, s.voided, u.name AS entered_by, s.shift_id, s.order_id
            FROM sales s LEFT JOIN users u ON u.id = s.entered_by WHERE s.station_id = $1 AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3) ORDER BY s.created_at`,
  expenses: `SELECT e.id, e.spent_at, e.category, e.amount, e.note, e.from_till, u.name AS entered_by, e.voided FROM expenses e LEFT JOIN users u ON u.id = e.user_id
              WHERE e.station_id = $1 AND ($2::timestamptz IS NULL OR e.created_at >= $2) AND ($3::timestamptz IS NULL OR e.created_at < $3) ORDER BY e.spent_at`,
  stock: `SELECT m.created_at, p.name AS product, p.variant, t.name AS tank, m.type, m.qty, m.balance_after, m.note FROM stock_movements m
           LEFT JOIN products p ON p.id = m.product_id LEFT JOIN tanks t ON t.id = m.tank_id WHERE m.station_id = $1
            AND ($2::timestamptz IS NULL OR m.created_at >= $2) AND ($3::timestamptz IS NULL OR m.created_at < $3) ORDER BY m.created_at`,
  orders: `SELECT o.id, o.created_at, u.name AS customer, o.status, o.fulfilment, o.total, o.payment_method, o.payment_status FROM orders o JOIN users u ON u.id = o.customer_id
            WHERE o.station_id = $1 AND ($2::timestamptz IS NULL OR o.created_at >= $2) AND ($3::timestamptz IS NULL OR o.created_at < $3) ORDER BY o.created_at`,
  restocks: `SELECT r.created_at, p.name AS product, p.variant, r.qty, r.cost_price, r.supplier_name, r.waybill, r.short_delivery, r.voided FROM restocks r JOIN products p ON p.id = r.product_id
              WHERE r.station_id = $1 AND ($2::timestamptz IS NULL OR r.created_at >= $2) AND ($3::timestamptz IS NULL OR r.created_at < $3) ORDER BY r.created_at`,
  shifts: `SELECT s.id, u.name AS staff, s.started_at, s.closed_at, s.admin_closed, s.pump_sales, s.manual_sales, s.credit_sales, s.expected_amount,
                  s.cash_declared, s.transfer_declared, s.pos_declared, s.variance_amount FROM shifts s JOIN users u ON u.id = s.user_id
            WHERE s.station_id = $1 AND ($2::timestamptz IS NULL OR s.started_at >= $2) AND ($3::timestamptz IS NULL OR s.started_at < $3) ORDER BY s.started_at`,
  'price-history': `SELECT h.effective_at, p.name AS product, p.variant, h.old_price, h.price AS new_price, u.name AS changed_by FROM price_history h
                     JOIN products p ON p.id = h.product_id LEFT JOIN users u ON u.id = h.changed_by WHERE h.station_id = $1 AND h.kind = 'change'
                      AND ($2::timestamptz IS NULL OR h.effective_at >= $2) AND ($3::timestamptz IS NULL OR h.effective_at < $3) ORDER BY h.effective_at`,
  'credit-ledger': `SELECT e.created_at, c.name AS customer, c.company, e.type, e.amount, e.description FROM credit_entries e JOIN credit_customers c ON c.id = e.credit_customer_id
                     WHERE e.station_id = $1 AND NOT e.voided AND ($2::timestamptz IS NULL OR e.created_at >= $2) AND ($3::timestamptz IS NULL OR e.created_at < $3) ORDER BY e.created_at`,
  audit: `SELECT created_at, user_name, action, entity, entity_id, note, before, after FROM audit_logs WHERE station_id = $1
           AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3) ORDER BY created_at`,
  // Fuel volumes per day and product, for regulator or tax reporting
  compliance: `SELECT to_char(s.created_at AT TIME ZONE st.timezone, 'YYYY-MM-DD') AS date, s.product_name AS fuel, SUM(s.qty) AS litres_sold, SUM(s.amount) AS sales_value
                FROM sales s JOIN products p ON p.id = s.product_id JOIN stations st ON st.id = s.station_id
               WHERE s.station_id = $1 AND NOT s.voided AND p.sale_type = 'metered' AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3)
               GROUP BY 1, 2 ORDER BY 1, 2`,
};

// Download any record set as CSV (opens in Excel) or JSON, for accountants and other tools
router.get('/:entity', wrap(async (req, res) => {
  const sql = ENTITIES[req.params.entity];
  if (!sql) throw bad(`Unknown export. Choose one of: ${Object.keys(ENTITIES).join(', ')}`);
  const rows = await many(sql, [req.stationId, req.query.from || null, req.query.to || null]);
  if (req.query.format === 'json') return res.json(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}.csv"`);
  res.send('\ufeff' + toCsv(rows));
}));

export default router;
