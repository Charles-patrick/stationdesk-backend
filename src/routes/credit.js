import { Router } from 'express';
import { one, many, tx, pool } from '../db.js';
import { z, parse, wrap, bad, notFound, id, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { sendEmail } from '../services/email.js';
import { fmtMoney } from '../utils/time.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

const withBalance = `
  SELECT c.*, COALESCE((SELECT SUM(CASE WHEN e.type = 'payment' THEN -e.amount ELSE e.amount END) FROM credit_entries e
                         WHERE e.credit_customer_id = c.id AND NOT e.voided), 0) AS balance,
         (SELECT MAX(e.created_at) FROM credit_entries e WHERE e.credit_customer_id = c.id AND e.type = 'payment' AND NOT e.voided) AS last_payment
    FROM credit_customers c`;

router.get('/customers', wrap(async (req, res) => {
  res.json(await many(`${withBalance} WHERE c.station_id = $1 ORDER BY c.active DESC, c.name`, [req.stationId]));
}));

router.get('/summary', adminOnly, wrap(async (req, res) => {
  const rows = await many(`${withBalance} WHERE c.station_id = $1 AND c.active`, [req.stationId]);
  const owing = rows.filter((r) => r.balance > 0);
  res.json({ total_owed: owing.reduce((s, r) => s + r.balance, 0), debtors: owing.length, customers: rows.length });
}));

const custSchema = z.object({
  name: z.string().trim().min(2), company: optStr, phone: optStr, email: optStr,
  credit_limit: z.coerce.number().min(0).default(0), notes: optStr,
});

router.post('/customers', adminOnly, wrap(async (req, res) => {
  const b = parse(custSchema, req.body);
  const row = await one(
    'INSERT INTO credit_customers (station_id, name, company, phone, email, credit_limit, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.stationId, b.name, b.company, b.phone, b.email, b.credit_limit, b.notes]);
  await audit(req, 'credit_customer_create', 'credit_customer', row.id, null, b);
  res.status(201).json(row);
}));

router.patch('/customers/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(custSchema.partial().extend({ active: z.boolean().optional() }), req.body);
  const row = await one(
    `UPDATE credit_customers SET name = COALESCE($1,name), company = COALESCE($2,company), phone = COALESCE($3,phone), email = COALESCE($4,email),
       credit_limit = COALESCE($5,credit_limit), notes = COALESCE($6,notes), active = COALESCE($7,active)
     WHERE id = $8 AND station_id = $9 RETURNING *`,
    [b.name, b.company, b.phone, b.email, b.credit_limit, b.notes, b.active, req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

router.get('/customers/:id', wrap(async (req, res) => {
  const c = await one(`${withBalance} WHERE c.id = $1 AND c.station_id = $2`, [req.params.id, req.stationId]);
  if (!c) throw notFound();
  const entries = await many(
    `SELECT e.*, u.name AS user_name FROM credit_entries e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.credit_customer_id = $1 AND NOT e.voided ORDER BY e.created_at DESC LIMIT 300`, [c.id]);
  res.json({ ...c, entries });
}));

router.post('/customers/:id/payment', wrap(async (req, res) => {
  const b = parse(z.object({ amount: z.coerce.number().positive(), description: optStr }), req.body);
  const row = await tx(async (client) => {
    const c = (await client.query('SELECT * FROM credit_customers WHERE id = $1 AND station_id = $2', [req.params.id, req.stationId])).rows[0];
    if (!c) throw notFound();
    const shift = (await client.query("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id])).rows[0];
    if (!shift && req.user.role === 'staff') throw bad('Start your shift before recording a payment');
    const { rows: [e] } = await client.query(
      `INSERT INTO credit_entries (station_id, credit_customer_id, type, amount, description, shift_id, user_id) VALUES ($1,$2,'payment',$3,$4,$5,$6) RETURNING *`,
      [req.stationId, c.id, b.amount, b.description || 'Payment received', shift?.id || null, req.user.id]);
    await audit(req, 'credit_payment', 'credit_customer', c.id, null, { amount: b.amount }, null, client);
    return e;
  });
  res.status(201).json(row);
}));

router.post('/customers/:id/reminder', adminOnly, wrap(async (req, res) => {
  const c = await one(`${withBalance} WHERE c.id = $1 AND c.station_id = $2`, [req.params.id, req.stationId]);
  if (!c) throw notFound();
  if (!c.email) throw bad('Add an email address for this customer first');
  if (c.balance <= 0) throw bad('This customer does not owe anything');
  const station = await one('SELECT name, currency FROM stations WHERE id = $1', [req.stationId]);
  const sent = await sendEmail({
    to: c.email, subject: `Payment reminder from ${station.name}`,
    text: `Hello ${c.name},\n\nThis is a friendly reminder that your balance with ${station.name} is ${fmtMoney(c.balance, station.currency)}.\nPlease arrange payment at your earliest convenience.\n\nThank you.`,
  });
  await audit(req, 'credit_reminder', 'credit_customer', c.id, null, { sent });
  res.json({ sent });
}));

export default router;
