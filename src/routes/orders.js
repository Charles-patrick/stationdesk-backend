import { Router } from 'express';
import { one, many, tx, pool } from '../db.js';
import { z, parse, wrap, bad, notFound, forbidden, id, optStr } from '../utils/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { moveProduct, round2, stockStatus } from '../utils/stock.js';
import { upload, fileUrl } from '../services/uploads.js';

const router = Router();
router.use(requireAuth);

// To add online payment later, add its key here and handle it in the frontend "Payment Method" section.
export const PAYMENT_METHODS = ['pay_on_pickup', 'bank_transfer'];
const ORDER = ['pending', 'confirmed', 'ready', 'completed'];
const isTeam = (u) => u.role === 'staff' || u.role === 'admin';

async function loadOrder(client, orderId, stationId) {
  const { rows: [o] } = await client.query(
    `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email, u.company AS customer_company,
            h.name AS handled_by_name FROM orders o JOIN users u ON u.id = o.customer_id LEFT JOIN users h ON h.id = o.handled_by
      WHERE o.id = $1 AND o.station_id = $2`, [orderId, stationId]);
  if (!o) return null;
  o.items = (await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [o.id])).rows;
  return o;
}

// ---- Customer vehicles (fleet) ----
router.get('/vehicles', requireRole('customer'), wrap(async (req, res) => {
  res.json(await many('SELECT * FROM fleet_vehicles WHERE customer_id = $1 ORDER BY plate', [req.user.id]));
}));
router.post('/vehicles', requireRole('customer'), wrap(async (req, res) => {
  const b = parse(z.object({ plate: z.string().trim().min(2).toUpperCase(), label: optStr }), req.body);
  res.status(201).json(await one('INSERT INTO fleet_vehicles (station_id, customer_id, plate, label) VALUES ($1,$2,$3,$4) RETURNING *', [req.stationId, req.user.id, b.plate, b.label]));
}));
router.delete('/vehicles/:id', requireRole('customer'), wrap(async (req, res) => {
  await one('DELETE FROM fleet_vehicles WHERE id = $1 AND customer_id = $2 RETURNING id', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---- Catalog for logged in customers (with prices) ----
router.get('/catalog', wrap(async (req, res) => {
  const station = await one('SELECT * FROM stations WHERE id = $1', [req.stationId]);
  if (!station.ordering_enabled) throw bad('This station is not taking online orders');
  const rows = await many(
    `SELECT p.id, p.name, p.variant, p.unit, p.selling_price, p.stock_qty, p.reorder_level, p.sale_type, p.image_url, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.station_id = $1 AND p.active AND p.orderable AND p.sale_type <> 'metered'
      ORDER BY c.sort, c.name, p.name, p.variant`, [req.stationId]);
  res.json(rows.map((p) => ({
    id: p.id, name: p.name, variant: p.variant, unit: p.unit, price: p.selling_price, category: p.category,
    image_url: p.image_url, availability: stockStatus(p),
    // Exact stock is only shown to the team; customers see in stock, low or out
    stock_qty: isTeam(req.user) ? p.stock_qty : undefined,
  })));
}));

router.post('/', requireRole('customer'), wrap(async (req, res) => {
  const b = parse(z.object({
    items: z.array(z.object({ product_id: id, qty: z.coerce.number().positive() })).min(1, 'Add at least one product'),
    fulfilment: z.enum(['pickup', 'delivery']).default('pickup'), delivery_address: optStr,
    preferred_at: z.string().optional().nullable(), note: optStr, vehicle: optStr,
    payment_method: z.enum(PAYMENT_METHODS).default('pay_on_pickup'),
  }), req.body);
  const order = await tx(async (client) => {
    const { rows: [station] } = await client.query('SELECT * FROM stations WHERE id = $1', [req.stationId]);
    if (!station.ordering_enabled) throw bad('This station is not taking online orders');
    if (b.fulfilment === 'delivery') {
      if (!station.delivery_enabled) throw bad('This station does not deliver. Choose pickup.');
      if (!b.delivery_address) throw bad('Enter the delivery address');
    }
    let total = 0;
    const lines = [];
    for (const it of b.items) {
      const { rows: [p] } = await client.query(
        "SELECT * FROM products WHERE id = $1 AND station_id = $2 AND active AND orderable AND sale_type <> 'metered'", [it.product_id, req.stationId]);
      if (!p) throw bad('One of those products can no longer be ordered');
      if (Number(p.stock_qty) < it.qty) throw bad(`Only ${p.stock_qty} ${p.unit} of ${p.name}${p.variant ? ' ' + p.variant : ''} available`);
      const amount = round2(Number(p.selling_price) * it.qty);
      total += amount;
      lines.push({ p, qty: it.qty, amount });
    }
    const { rows: [o] } = await client.query(
      `INSERT INTO orders (station_id, customer_id, fulfilment, delivery_address, preferred_at, note, vehicle, total, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.stationId, req.user.id, b.fulfilment, b.delivery_address, b.preferred_at || null, b.note, b.vehicle, round2(total), b.payment_method]);
    for (const l of lines) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, name, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.id, l.p.id, l.p.variant ? `${l.p.name} ${l.p.variant}` : l.p.name, l.qty, l.p.selling_price, l.amount]);
    }
    await audit(req, 'order_create', 'order', o.id, null, { total: o.total }, null, client);
    await notify({ stationId: req.stationId, role: 'staff', type: 'order', client, email: false, title: `New order #${o.id} from ${req.user.name}`, body: `${lines.length} item(s), total ${o.total}`, link: '/staff/orders' });
    await notify({ stationId: req.stationId, role: 'admin', type: 'order', client, title: `New order #${o.id} from ${req.user.name}`, body: `${lines.length} item(s), total ${o.total}`, link: '/staff/orders' });
    return o;
  });
  res.status(201).json(await loadOrder(pool, order.id, req.stationId));
}));

router.get('/', wrap(async (req, res) => {
  const { status, from, to } = req.query;
  const customerOnly = req.user.role === 'customer';
  res.json(await many(
    `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone,
        (SELECT string_agg(i.qty || ' x ' || i.name, ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS summary
       FROM orders o JOIN users u ON u.id = o.customer_id
      WHERE o.station_id = $1 AND ($2::boolean IS NOT TRUE OR o.customer_id = $3) AND ($4::text IS NULL OR o.status = $4)
        AND ($5::timestamptz IS NULL OR o.created_at >= $5) AND ($6::timestamptz IS NULL OR o.created_at < $6)
      ORDER BY o.created_at DESC LIMIT 300`,
    [req.stationId, customerOnly, req.user.id, status || null, from || null, to || null]));
}));

router.get('/:id', wrap(async (req, res) => {
  const o = await loadOrder(pool, req.params.id, req.stationId);
  if (!o) throw notFound('Order not found');
  if (req.user.role === 'customer' && o.customer_id !== req.user.id) throw forbidden();
  res.json(o);
}));

router.post('/:id/status', wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['confirmed', 'ready', 'completed', 'cancelled']) }), req.body);
  const result = await tx(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!o) throw notFound('Order not found');
    if (req.user.role === 'customer') {
      if (o.customer_id !== req.user.id) throw forbidden();
      if (b.status !== 'cancelled' || o.status !== 'pending') throw bad('You can only cancel an order that has not been confirmed yet');
    }
    if (['completed', 'cancelled'].includes(o.status)) throw bad(`This order is already ${o.status}`);
    if (b.status !== 'cancelled' && ORDER.indexOf(b.status) <= ORDER.indexOf(o.status)) throw bad('That step has already happened');

    let points = 0;
    if (b.status === 'completed') {
      const { rows: [station] } = await client.query('SELECT * FROM stations WHERE id = $1', [req.stationId]);
      const shift = (await client.query("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id])).rows[0];
      const items = (await client.query('SELECT * FROM order_items WHERE order_id = $1', [o.id])).rows;
      for (const it of items) {
        const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
        if (Number(p.stock_qty) < Number(it.qty)) throw bad(`Not enough ${it.name} in stock to complete this order. Record the restock first.`);
        const { rows: [sale] } = await client.query(
          `INSERT INTO sales (station_id, shift_id, product_id, product_name, qty, unit_price, amount, source, payment, order_id, client_id, entered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'order',$8,$9,$10,$11) RETURNING id`,
          [req.stationId, shift?.id || null, it.product_id, it.name, it.qty, it.unit_price, it.amount,
            o.payment_method === 'bank_transfer' ? 'transfer' : 'cash', o.id, `order-${o.id}-${it.id}`, req.user.id]);
        await moveProduct(client, { stationId: req.stationId, productId: it.product_id, delta: -Number(it.qty), type: 'order', refType: 'order', refId: o.id, userId: req.user.id });
      }
      if (station.loyalty_enabled && station.loyalty_points_per_1000 > 0) {
        points = Math.floor(Number(o.total) / 1000) * station.loyalty_points_per_1000;
        if (points > 0) await client.query('UPDATE users SET loyalty_points = loyalty_points + $1 WHERE id = $2', [points, o.customer_id]);
      }
    }
    await client.query(
      `UPDATE orders SET status = $1, updated_at = now(), handled_by = COALESCE($2, handled_by), points_awarded = points_awarded + $3,
         payment_status = CASE WHEN $1 = 'completed' THEN 'paid' ELSE payment_status END WHERE id = $4`,
      [b.status, isTeam(req.user) ? req.user.id : null, points, o.id]);
    await audit(req, 'order_status', 'order', o.id, { status: o.status }, { status: b.status }, null, client);
    if (isTeam(req.user)) {
      const text = { confirmed: 'has been confirmed', ready: 'is ready', completed: 'is complete. Thank you!', cancelled: 'was cancelled' }[b.status];
      await notify({ stationId: req.stationId, userIds: [o.customer_id], type: 'order', client, title: `Order #${o.id} ${text}`, body: b.status === 'ready' ? (o.fulfilment === 'pickup' ? 'You can collect it now.' : 'It is on its way.') : null, link: `/orders/${o.id}` });
    } else {
      await notify({ stationId: req.stationId, role: 'staff', type: 'order', client, email: false, title: `Order #${o.id} was cancelled by the customer`, link: '/staff/orders' });
    }
    return { status: b.status, points };
  });
  res.json(result);
}));

router.post('/:id/proof', requireRole('customer'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Choose a photo or PDF of your transfer receipt');
  const row = await one('UPDATE orders SET proof_url = $1, updated_at = now() WHERE id = $2 AND customer_id = $3 RETURNING id, proof_url', [fileUrl(req.file), req.params.id, req.user.id]);
  if (!row) throw notFound('Order not found');
  await notify({ stationId: req.stationId, role: 'staff', type: 'order', email: false, title: `Payment proof uploaded for order #${row.id}`, link: '/staff/orders' });
  res.json(row);
}));

router.post('/:id/payment', requireRole('staff', 'admin'), wrap(async (req, res) => {
  const b = parse(z.object({ payment_status: z.enum(['paid', 'unpaid']) }), req.body);
  const row = await one('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2 AND station_id = $3 RETURNING id, payment_status', [b.payment_status, req.params.id, req.stationId]);
  if (!row) throw notFound();
  await audit(req, 'order_payment', 'order', row.id, null, b);
  res.json(row);
}));

export default router;
