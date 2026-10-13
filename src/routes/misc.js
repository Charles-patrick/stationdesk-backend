import { Router } from 'express';
import { one, many, q, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, forbidden, id } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { applyVoid, applyQtyEdit } from './sales.js';
import { round2 } from '../utils/stock.js';

export const notifications = Router();
notifications.use(requireAuth);

notifications.get('/', wrap(async (req, res) => {
  const rows = await many('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60', [req.user.id]);
  const unread = await one('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT read', [req.user.id]);
  res.json({ items: rows, unread: unread.n });
}));

notifications.post('/read', wrap(async (req, res) => {
  const b = parse(z.object({ ids: z.array(id).optional() }), req.body);
  if (b.ids?.length) await q('UPDATE notifications SET read = TRUE WHERE user_id = $1 AND id = ANY($2)', [req.user.id, b.ids]);
  else await q('UPDATE notifications SET read = TRUE WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

export const auditRouter = Router();
auditRouter.use(requireAuth, adminOnly);

auditRouter.get('/', wrap(async (req, res) => {
  const { entity, user_id, action, from, to, q: search } = req.query;
  const rows = await many(
    `SELECT * FROM audit_logs WHERE station_id = $1 AND ($2::text IS NULL OR entity = $2) AND ($3::bigint IS NULL OR user_id = $3)
       AND ($4::text IS NULL OR action = $4) AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at < $6)
       AND ($7::text IS NULL OR action ILIKE '%' || $7 || '%' OR note ILIKE '%' || $7 || '%' OR user_name ILIKE '%' || $7 || '%')
     ORDER BY created_at DESC, id DESC LIMIT 300`,
    [req.stationId, entity || null, user_id || null, action || null, from || null, to || null, search || null]);
  res.json(rows);
}));

// ---- Approvals: edits to closed shifts need an admin ----
export const approvals = Router();
approvals.use(requireAuth, staffOrAdmin);

approvals.get('/', wrap(async (req, res) => {
  const mine = req.user.role === 'staff';
  const rows = await many(
    `SELECT r.*, u.name AS requested_by_name, d.name AS decided_by_name,
        (SELECT row_to_json(x) FROM (SELECT s.product_name, s.qty, s.amount FROM sales s WHERE s.id = r.entity_id AND r.type IN ('void_sale','edit_sale_qty')) x) AS sale
       FROM edit_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
      WHERE r.station_id = $1 AND ($2::boolean IS NOT TRUE OR r.requested_by = $3) AND ($4::text IS NULL OR r.status = $4)
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`,
    [req.stationId, mine, req.user.id, req.query.status || null]);
  res.json(rows);
}));

approvals.post('/shift-cash', wrap(async (req, res) => {
  const b = parse(z.object({
    shift_id: id, cash: z.coerce.number().min(0), transfer: z.coerce.number().min(0), pos: z.coerce.number().min(0), reason: z.string().trim().min(3),
  }), req.body);
  const shift = await one('SELECT * FROM shifts WHERE id = $1 AND station_id = $2', [b.shift_id, req.stationId]);
  if (!shift) throw notFound('Shift not found');
  if (shift.status !== 'closed') throw bad('Close the shift first. You can set the totals while closing.');
  if (req.user.role !== 'admin' && shift.user_id !== req.user.id) throw forbidden();
  if (req.user.role === 'admin') {
    await applyCashEdit(req, shift, b);
    return res.json({ edited: true });
  }
  const row = await one(
    `INSERT INTO edit_requests (station_id, shift_id, type, entity_id, payload, reason, requested_by) VALUES ($1,$2,'edit_shift_cash',$2,$3,$4,$5) RETURNING id`,
    [req.stationId, shift.id, JSON.stringify({ cash: b.cash, transfer: b.transfer, pos: b.pos }), b.reason, req.user.id]);
  await notify({ stationId: req.stationId, role: 'admin', type: 'approval', title: 'Approval needed: change cash totals on a closed shift', body: b.reason, link: '/admin/approvals' });
  res.status(201).json({ requested: true, request_id: row.id });
}));

async function applyCashEdit(ctx, shift, p, client = null) {
  const run = async (c) => {
    const declared = round2(p.cash + p.transfer + p.pos);
    const variance = round2(declared - Number(shift.expected_amount));
    const station = (await c.query('SELECT cash_tolerance_pct FROM stations WHERE id = $1', [shift.station_id])).rows[0];
    const flags = (shift.flags || []).filter((f) => f.type !== 'cash');
    if (Math.abs(variance) > Math.max(1, (Number(station.cash_tolerance_pct) / 100) * Math.abs(Number(shift.expected_amount)))) {
      flags.push({ type: 'cash', expected: Number(shift.expected_amount), declared, amount: variance });
    }
    await c.query(
      'UPDATE shifts SET cash_declared=$1, transfer_declared=$2, pos_declared=$3, variance_amount=$4, flags=$5 WHERE id=$6',
      [p.cash, p.transfer, p.pos, variance, JSON.stringify(flags), shift.id]);
    await audit(ctx, 'shift_cash_edit', 'shift', shift.id,
      { cash: shift.cash_declared, transfer: shift.transfer_declared, pos: shift.pos_declared }, { cash: p.cash, transfer: p.transfer, pos: p.pos }, p.reason || null, c);
  };
  if (client) return run(client);
  return tx(run);
}

approvals.post('/:id/decide', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().optional().nullable() }), req.body);
  await tx(async (client) => {
    const { rows: [r] } = await client.query('SELECT * FROM edit_requests WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!r) throw notFound('Request not found');
    if (r.status !== 'pending') throw bad('This request has already been decided');
    if (b.approve) {
      if (r.type === 'void_sale' || r.type === 'edit_sale_qty') {
        const sale = (await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [r.entity_id])).rows[0];
        if (!sale) throw notFound('The sale no longer exists');
        if (r.type === 'void_sale') await applyVoid(client, req, sale, r.reason);
        else await applyQtyEdit(client, req, sale, Number(r.payload.qty), r.reason);
      } else if (r.type === 'edit_shift_cash') {
        const shift = (await client.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [r.entity_id])).rows[0];
        await applyCashEdit(req, shift, { ...r.payload, reason: r.reason }, client);
      }
    }
    await client.query(
      'UPDATE edit_requests SET status = $1, decided_by = $2, decision_note = $3, decided_at = now() WHERE id = $4',
      [b.approve ? 'approved' : 'rejected', req.user.id, b.note || null, r.id]);
    await audit(req, b.approve ? 'approval_approved' : 'approval_rejected', 'edit_request', r.id, null, { type: r.type }, b.note || null, client);
    await notify({ stationId: req.stationId, userIds: [r.requested_by], type: 'approval', client, email: false,
      title: `Your request was ${b.approve ? 'approved' : 'rejected'}`, body: b.note || r.reason, link: '/staff/shift' });
  });
  res.json({ ok: true });
}));
