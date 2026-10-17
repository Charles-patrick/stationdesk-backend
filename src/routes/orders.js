import { Router } from 'express';
import { one, many, tx, pool } from '../db.js';
import { z, parse, wrap, bad, notFound } from '../utils/http.js';
import { requireAuth, staffOrAdmin } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { moveProduct } from '../utils/stock.js';
import { sendEmail } from '../services/email.js';
import { config } from '../config.js';

// Staff and admins work the incoming orders here. Customers use the public routes (no account needed).
const router = Router();
router.use(requireAuth, staffOrAdmin);

const ORDER = ['pending', 'confirmed', 'ready', 'completed'];

async function loadOrder(client, orderId, stationId) {
  const { rows: [o] } = await client.query(
    `SELECT o.*, h.name AS handled_by_name FROM orders o LEFT JOIN users h ON h.id = o.handled_by WHERE o.id = $1 AND o.station_id = $2`, [orderId, stationId]);
  if (!o) return null;
  o.items = (await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [o.id])).rows;
  return o;
}

router.get('/', wrap(async (req, res) => {
  const { status, from, to } = req.query;
  res.json(await many(
    `SELECT o.*, (SELECT string_agg(i.qty || ' x ' || i.name, ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS summary
       FROM orders o
      WHERE o.station_id = $1 AND ($2::text IS NULL OR o.status = $2)
        AND ($3::timestamptz IS NULL OR o.created_at >= $3) AND ($4::timestamptz IS NULL OR o.created_at < $4)
      ORDER BY o.created_at DESC LIMIT 300`,
    [req.stationId, status || null, from || null, to || null]));
}));

router.get('/:id', wrap(async (req, res) => {
  const o = await loadOrder(pool, req.params.id, req.stationId);
  if (!o) throw notFound('Order not found');
  res.json(o);
}));

router.post('/:id/status', wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['confirmed', 'ready', 'completed', 'cancelled']) }), req.body);
  const out = await tx(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!o) throw notFound('Order not found');
    if (['completed', 'cancelled'].includes(o.status)) throw bad(`This order is already ${o.status}`);
    if (b.status !== 'cancelled' && ORDER.indexOf(b.status) <= ORDER.indexOf(o.status)) throw bad('That step has already happened');

    if (b.status === 'completed') {
      // Attendants' sales go on their shift. Admins have no shift, so the sale is recorded without one.
      const shift = (await client.query("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id])).rows[0];
      const items = (await client.query('SELECT * FROM order_items WHERE order_id = $1', [o.id])).rows;
      for (const it of items) {
        const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
        if (Number(p.stock_qty) < Number(it.qty)) throw bad(`Not enough ${it.name} in stock to complete this order. Record the restock first.`);
        await client.query(
          `INSERT INTO sales (station_id, shift_id, product_id, product_name, qty, unit_price, amount, source, payment, order_id, client_id, entered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'order',$8,$9,$10,$11)`,
          [req.stationId, shift?.id || null, it.product_id, it.name, it.qty, it.unit_price, it.amount,
            o.payment_method === 'bank_transfer' ? 'transfer' : 'cash', o.id, `order-${o.id}-${it.id}`, req.user.id]);
        await moveProduct(client, { stationId: req.stationId, productId: it.product_id, delta: -Number(it.qty), type: 'order', refType: 'order', refId: o.id, userId: req.user.id });
      }
    }
    await client.query(
      `UPDATE orders SET status = $1, updated_at = now(), handled_by = $2,
         payment_status = CASE WHEN $1 = 'completed' THEN 'paid' ELSE payment_status END WHERE id = $3`,
      [b.status, req.user.id, o.id]);
    await audit(req, 'order_status', 'order', o.id, { status: o.status }, { status: b.status }, null, client);
    return o;
  });
  if (out.customer_email) {
    const station = await one('SELECT slug, name FROM stations WHERE id = $1', [req.stationId]);
    const text = { confirmed: 'has been confirmed', ready: out.fulfilment === 'pickup' ? 'is ready. You can collect it now' : 'is ready and on its way', completed: 'is complete. Thank you', cancelled: 'was cancelled' }[b.status];
    sendEmail({
      to: out.customer_email, subject: `Order #${out.id} ${text.split('.')[0]}`,
      text: `Hello ${out.customer_name},\n\nYour order #${out.id} with ${station.name} ${text}.\n\nTrack it here: ${config.frontendUrl}/s/${station.slug}/track/${out.tracking_token}`,
    });
  }
  res.json({ status: b.status });
}));

router.post('/:id/payment', wrap(async (req, res) => {
  const b = parse(z.object({ payment_status: z.enum(['paid', 'unpaid']) }), req.body);
  const row = await one('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2 AND station_id = $3 RETURNING id, payment_status', [b.payment_status, req.params.id, req.stationId]);
  if (!row) throw notFound();
  await audit(req, 'order_payment', 'order', row.id, null, b);
  res.json(row);
}));

export default router;
