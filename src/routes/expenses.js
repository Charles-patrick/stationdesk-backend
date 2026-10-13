import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, forbidden, money, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { upload, fileUrl } from '../services/uploads.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

export const EXPENSE_CATEGORIES = ['Generator fuel', 'Wages', 'Repairs and maintenance', 'Electricity', 'Cleaning', 'Transport', 'Licences and levies', 'Other'];

router.get('/categories', (_req, res) => res.json(EXPENSE_CATEGORIES));

router.post('/', wrap(async (req, res) => {
  const b = parse(z.object({
    category: z.string().trim().min(2), amount: money.refine((n) => n > 0, 'Enter an amount'), spent_at: z.string().optional(),
    note: optStr, from_till: z.boolean().default(false), client_id: z.string().max(80).optional().nullable(),
  }), req.body);
  const out = await tx(async (client) => {
    if (b.client_id) {
      const dupe = (await client.query('SELECT * FROM expenses WHERE station_id = $1 AND client_id = $2', [req.stationId, b.client_id])).rows[0];
      if (dupe) return dupe;
    }
    const shift = (await client.query("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id])).rows[0];
    if (b.from_till && !shift) throw bad('Start your shift to record an expense paid from the till');
    const { rows: [row] } = await client.query(
      `INSERT INTO expenses (station_id, shift_id, category, amount, spent_at, note, from_till, client_id, user_id)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8,$9) RETURNING *`,
      [req.stationId, b.from_till ? shift.id : (shift?.id || null), b.category, b.amount, b.spent_at || null, b.note, b.from_till, b.client_id || null, req.user.id]);
    await audit(req, 'expense_create', 'expense', row.id, null, { category: b.category, amount: b.amount }, null, client);
    return row;
  });
  res.status(201).json(out);
}));

router.post('/:id/receipt', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Choose a receipt photo to upload');
  const row = await one('UPDATE expenses SET receipt_url = $1 WHERE id = $2 AND station_id = $3 RETURNING id, receipt_url', [fileUrl(req.file), req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

router.get('/', wrap(async (req, res) => {
  const { from, to } = req.query;
  const mine = req.user.role === 'staff';
  res.json(await many(
    `SELECT e.*, u.name AS user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.station_id = $1 AND NOT e.voided AND ($2::date IS NULL OR e.spent_at >= $2) AND ($3::date IS NULL OR e.spent_at <= $3)
        AND ($4::boolean IS NOT TRUE OR e.user_id = $5)
      ORDER BY e.spent_at DESC, e.id DESC LIMIT 300`, [req.stationId, from || null, to || null, mine, req.user.id]));
}));

router.post('/:id/void', wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  await tx(async (client) => {
    const { rows: [e] } = await client.query('SELECT e.*, s.status AS shift_status FROM expenses e LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1 AND e.station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!e || e.voided) throw notFound('Expense not found');
    const own = e.user_id === req.user.id && (!e.shift_id || e.shift_status === 'open');
    if (req.user.role !== 'admin' && !own) throw forbidden('Ask an admin to cancel this expense');
    await client.query('UPDATE expenses SET voided = TRUE WHERE id = $1', [e.id]);
    await audit(req, 'expense_void', 'expense', e.id, { amount: e.amount }, { voided: true }, b.reason, client);
  });
  res.json({ ok: true });
}));

export default router;
