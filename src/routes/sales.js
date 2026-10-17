import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, forbidden, id, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { moveProduct, round2 } from '../utils/stock.js';
import { notify } from '../utils/notify.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

router.post('/', wrap(async (req, res) => {
  const b = parse(z.object({
    product_id: id, qty: z.coerce.number().positive(), payment: z.enum(['cash', 'transfer', 'pos']).default('cash'),
    unit_price: z.coerce.number().min(0).optional(),
    client_id: z.string().max(80).optional().nullable(), note: optStr,
  }), req.body);

  const out = await tx(async (client) => {
    if (b.client_id) {
      const dupe = (await client.query('SELECT * FROM sales WHERE station_id = $1 AND client_id = $2', [req.stationId, b.client_id])).rows[0];
      if (dupe) return { sale: dupe, duplicate: true };
    }
    if (req.user.role === 'admin') throw bad('Sales are recorded by attendants on their shifts. Admins can review and correct them.');
    const { rows: [shift] } = await client.query("SELECT * FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id]);
    if (!shift) throw bad('Start your shift before recording sales');
    const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1 AND station_id = $2 AND active FOR UPDATE', [b.product_id, req.stationId]);
    if (!p) throw bad('Product not found');
    if (p.sale_type === 'metered') throw bad('Fuel sales come from the pump readings when you close your shift');
    if (p.sale_type !== 'service' && Number(p.stock_qty) < b.qty) {
      throw bad(`Only ${p.stock_qty} ${p.unit} of ${p.name}${p.variant ? ' ' + p.variant : ''} in stock. Record the restock first or reduce the quantity.`);
    }
    const price = p.sale_type === 'service' && b.unit_price !== undefined ? b.unit_price : Number(p.selling_price);
    const amount = round2(price * b.qty);
    const { rows: [sale] } = await client.query(
      `INSERT INTO sales (station_id, shift_id, product_id, product_name, qty, unit_price, amount, source, payment, client_id, note, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11) RETURNING *`,
      [req.stationId, shift?.id || null, p.id, p.variant ? `${p.name} ${p.variant}` : p.name, b.qty, price, amount, b.payment,
        b.client_id || null, b.note, req.user.id]);
    if (p.sale_type !== 'service') {
      await moveProduct(client, { stationId: req.stationId, productId: p.id, delta: -b.qty, type: 'sale', refType: 'sale', refId: sale.id, userId: req.user.id });
    }
    await audit(req, 'sale_create', 'sale', sale.id, null, { product: sale.product_name, qty: sale.qty, amount }, null, client);
    return { sale, duplicate: false };
  });
  res.status(out.duplicate ? 200 : 201).json(out.sale);
}));

router.get('/', wrap(async (req, res) => {
  const { from, to, shift_id, product_id, source } = req.query;
  const mine = req.user.role === 'staff';
  const rows = await many(
    `SELECT s.*, u.name AS entered_by_name, sh.status AS shift_status FROM sales s
       LEFT JOIN users u ON u.id = s.entered_by LEFT JOIN shifts sh ON sh.id = s.shift_id
      WHERE s.station_id = $1 AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3)
        AND ($4::bigint IS NULL OR s.shift_id = $4) AND ($5::bigint IS NULL OR s.product_id = $5) AND ($6::text IS NULL OR s.source = $6)
        AND ($7::boolean IS NOT TRUE OR s.entered_by = $8)
      ORDER BY s.created_at DESC LIMIT 500`,
    [req.stationId, from || null, to || null, shift_id || null, product_id || null, source || null, mine, req.user.id]);
  res.json(rows);
}));

export async function applyVoid(client, ctx, sale, reason) {
  if (sale.voided) throw bad('This sale is already cancelled');
  if (sale.source === 'pump') throw bad('Pump sales come from meter readings. Ask an admin to correct the shift instead.');
  await client.query('UPDATE sales SET voided = TRUE, void_reason = $1, voided_by = $2 WHERE id = $3', [reason, ctx.user.id, sale.id]);
  const { rows: [p] } = await client.query('SELECT sale_type FROM products WHERE id = $1', [sale.product_id]);
  if (p && p.sale_type !== 'service') {
    await moveProduct(client, { stationId: sale.station_id, productId: sale.product_id, delta: Number(sale.qty), type: 'void', refType: 'sale', refId: sale.id, note: reason, userId: ctx.user.id });
  }
  await audit(ctx, 'sale_void', 'sale', sale.id, { amount: sale.amount, qty: sale.qty }, { voided: true }, reason, client);
}

router.post('/:id/void', wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3, 'Say why this sale is being cancelled') }), req.body);
  const result = await tx(async (client) => {
    const { rows: [sale] } = await client.query('SELECT * FROM sales WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!sale) throw notFound('Sale not found');
    const shift = sale.shift_id ? (await client.query('SELECT * FROM shifts WHERE id = $1', [sale.shift_id])).rows[0] : null;
    const isAdmin = req.user.role === 'admin';
    const shiftOpen = !shift || shift.status === 'open';
    if (isAdmin || (shiftOpen && sale.entered_by === req.user.id)) {
      await applyVoid(client, req, sale, b.reason);
      return { voided: true };
    }
    if (sale.entered_by !== req.user.id) throw forbidden('You can only cancel sales you entered');
    const { rows: [er] } = await client.query(
      `INSERT INTO edit_requests (station_id, shift_id, type, entity_id, reason, requested_by) VALUES ($1,$2,'void_sale',$3,$4,$5) RETURNING id`,
      [req.stationId, sale.shift_id, sale.id, b.reason, req.user.id]);
    await notify({ stationId: req.stationId, role: 'admin', type: 'approval', client, title: 'Approval needed: cancel a sale on a closed shift', body: b.reason, link: '/admin/approvals' });
    return { requested: true, request_id: er.id };
  });
  res.json(result);
}));

router.post('/:id/edit-qty', wrap(async (req, res) => {
  const b = parse(z.object({ qty: z.coerce.number().positive(), reason: z.string().trim().min(3) }), req.body);
  const result = await tx(async (client) => {
    const { rows: [sale] } = await client.query('SELECT * FROM sales WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!sale || sale.voided) throw notFound('Sale not found');
    if (sale.source === 'pump') throw bad('Pump sales come from meter readings');
    const shift = sale.shift_id ? (await client.query('SELECT * FROM shifts WHERE id = $1', [sale.shift_id])).rows[0] : null;
    const open = !shift || shift.status === 'open';
    if (req.user.role === 'admin' || (open && sale.entered_by === req.user.id)) {
      await applyQtyEdit(client, req, sale, b.qty, b.reason);
      return { edited: true };
    }
    if (sale.entered_by !== req.user.id) throw forbidden('You can only change sales you entered');
    const { rows: [er] } = await client.query(
      `INSERT INTO edit_requests (station_id, shift_id, type, entity_id, payload, reason, requested_by) VALUES ($1,$2,'edit_sale_qty',$3,$4,$5,$6) RETURNING id`,
      [req.stationId, sale.shift_id, sale.id, JSON.stringify({ qty: b.qty }), b.reason, req.user.id]);
    await notify({ stationId: req.stationId, role: 'admin', type: 'approval', client, title: 'Approval needed: change a sale on a closed shift', body: b.reason, link: '/admin/approvals' });
    return { requested: true, request_id: er.id };
  });
  res.json(result);
}));

export async function applyQtyEdit(client, ctx, sale, qty, reason) {
  const diff = round2(qty - Number(sale.qty));
  const amount = round2(qty * Number(sale.unit_price));
  const { rows: [p] } = await client.query('SELECT sale_type, stock_qty FROM products WHERE id = $1', [sale.product_id]);
  if (p.sale_type !== 'service') {
    if (diff > 0 && Number(p.stock_qty) < diff) throw bad('Not enough stock for that increase');
    await moveProduct(client, { stationId: sale.station_id, productId: sale.product_id, delta: -diff, type: 'adjustment', refType: 'sale', refId: sale.id, note: `Sale quantity corrected: ${reason}`, userId: ctx.user.id });
  }
  await client.query('UPDATE sales SET qty = $1, amount = $2 WHERE id = $3', [qty, amount, sale.id]);
  await audit(ctx, 'sale_edit', 'sale', sale.id, { qty: sale.qty, amount: sale.amount }, { qty, amount }, reason, client);
}

export default router;
