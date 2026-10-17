import { Router } from 'express';
import { one, many, tx, pool } from '../db.js';
import { z, parse, wrap, bad, notFound, id, optStr, HttpError } from '../utils/http.js';
import { stationBySlug, throttle } from './auth.js';
import { stockStatus, round2 } from '../utils/stock.js';
import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { sendEmail } from '../services/email.js';
import { upload, fileUrl } from '../services/uploads.js';
import { config } from '../config.js';

const router = Router();

const publicStation = (s) => ({
  id: s.id, slug: s.slug, name: s.name, logo_url: s.logo_url, brand_color: s.brand_color, address: s.address,
  phone: s.phone, currency: s.currency, ordering_enabled: s.ordering_enabled, delivery_enabled: s.delivery_enabled,
  delivery_note: s.delivery_note, paused: !s.active,
});

const digits = (v) => String(v || '').replace(/\D/g, '');
const trackLink = (slug, token) => `${config.frontendUrl}/s/${slug}/track/${token}`;

// The customer-facing store: open to everyone, prices always shown
router.get('/station/:slug', wrap(async (req, res) => {
  res.json(publicStation(await stationBySlug(req.params.slug, { allowInactive: true })));
}));

router.get('/station/:slug/catalog', wrap(async (req, res) => {
  const s = await stationBySlug(req.params.slug, { allowInactive: true });
  if (!s.active || !s.ordering_enabled) return res.json({ station: publicStation(s), products: [] });
  const rows = await many(
    `SELECT p.id, p.name, p.variant, p.unit, p.sale_type, p.selling_price, p.stock_qty, p.reorder_level, p.image_url, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.station_id = $1 AND p.active AND p.orderable AND p.sale_type <> 'metered'
      ORDER BY c.sort, c.name, p.name, p.variant`, [s.id]);
  res.json({
    station: publicStation(s),
    products: rows.map((p) => ({
      id: p.id, name: p.name, variant: p.variant, unit: p.unit, category: p.category, image_url: p.image_url,
      price: p.selling_price, availability: stockStatus(p),
    })),
  });
}));

router.get('/station/:slug/help', wrap(async (req, res) => {
  const s = await stationBySlug(req.params.slug);
  res.json(await many(
    "SELECT id, audience, title, body, video_url, sort FROM station_help WHERE station_id = $1 AND audience = 'customer' AND published ORDER BY sort, id", [s.id]));
}));

async function loadByToken(client, token) {
  const { rows: [o] } = await client.query(
    `SELECT o.id, o.station_id, o.status, o.fulfilment, o.delivery_address, o.preferred_at, o.note, o.vehicle, o.total, o.payment_method,
            o.payment_status, o.proof_url, o.created_at, o.customer_name, o.customer_phone, o.customer_email, o.tracking_token
       FROM orders o WHERE o.tracking_token = $1`, [String(token || '')]);
  if (!o) return null;
  o.items = (await client.query('SELECT id, name, qty, unit_price, amount FROM order_items WHERE order_id = $1 ORDER BY id', [o.id])).rows;
  const { rows: [s] } = await client.query('SELECT slug, name, phone, address, currency, brand_color, logo_url FROM stations WHERE id = $1', [o.station_id]);
  o.station = s;
  return o;
}

// To add online payment later, add its key here and handle it in the checkout "Payment Method" section.
const PAYMENT_METHODS = ['pay_on_pickup', 'bank_transfer'];

router.post('/station/:slug/orders', wrap(async (req, res) => {
  throttle(`order|${req.ip}`, 12, 60 * 60 * 1000, 'Too many orders from this connection. Please try again later or call the station.');
  const b = parse(z.object({
    customer_name: z.string().trim().min(2, 'Enter your name'), customer_phone: z.string().trim().min(7, 'Enter a phone number we can call'),
    customer_email: z.string().trim().email().optional().nullable().or(z.literal('')),
    items: z.array(z.object({ product_id: id, qty: z.coerce.number().positive() })).min(1, 'Add at least one product').max(40),
    fulfilment: z.enum(['pickup', 'delivery']).default('pickup'), delivery_address: optStr,
    preferred_at: z.string().optional().nullable(), note: optStr, vehicle: optStr,
    payment_method: z.enum(PAYMENT_METHODS).default('pay_on_pickup'),
    website: z.string().optional(), // hidden field: real people leave it empty
  }), req.body);
  if (b.website) throw bad('Something went wrong. Please try again.');
  throttle(`orderphone|${digits(b.customer_phone)}`, 6, 60 * 60 * 1000, 'Too many orders from this phone number. Please call the station.');
  const station = await stationBySlug(req.params.slug);
  const created = await tx(async (client) => {
    if (!station.ordering_enabled) throw bad('This station is not taking online orders right now');
    if (b.fulfilment === 'delivery') {
      if (!station.delivery_enabled) throw bad('This station does not deliver. Choose pickup.');
      if (!b.delivery_address) throw bad('Enter the delivery address');
    }
    let total = 0;
    const lines = [];
    for (const it of b.items) {
      const { rows: [p] } = await client.query(
        "SELECT * FROM products WHERE id = $1 AND station_id = $2 AND active AND orderable AND sale_type <> 'metered'", [it.product_id, station.id]);
      if (!p) throw bad('One of those products can no longer be ordered');
      if (Number(p.stock_qty) < it.qty) throw bad(`Only ${p.stock_qty} ${p.unit} of ${p.name}${p.variant ? ' ' + p.variant : ''} available`);
      const amount = round2(Number(p.selling_price) * it.qty);
      total += amount;
      lines.push({ p, qty: it.qty, amount });
    }
    const { rows: [o] } = await client.query(
      `INSERT INTO orders (station_id, customer_name, customer_phone, customer_email, fulfilment, delivery_address, preferred_at, note, vehicle, total, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, tracking_token, total`,
      [station.id, b.customer_name, b.customer_phone, b.customer_email || null, b.fulfilment, b.delivery_address, b.preferred_at || null,
        b.note, b.vehicle, round2(total), b.payment_method]);
    for (const l of lines) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, name, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.id, l.p.id, l.p.variant ? `${l.p.name} ${l.p.variant}` : l.p.name, l.qty, l.p.selling_price, l.amount]);
    }
    await audit({ stationId: station.id, user: { name: `${b.customer_name} (customer)` } }, 'order_create', 'order', o.id, null, { total: o.total }, null, client);
    const text = `${lines.length} item(s), total ${o.total}. ${b.customer_name}, ${b.customer_phone}`;
    await notify({ stationId: station.id, role: 'staff', type: 'order', client, email: false, title: `New order #${o.id}`, body: text, link: '/staff/orders' });
    await notify({ stationId: station.id, role: 'admin', type: 'order', client, title: `New order #${o.id}`, body: text, link: '/staff/orders' });
    return o;
  });
  if (b.customer_email) {
    sendEmail({
      to: b.customer_email, subject: `Your order #${created.id} with ${station.name}`,
      text: `Thank you, ${b.customer_name}.\n\nWe received your order #${created.id}. You can check its status, or cancel it before it is confirmed, here:\n${trackLink(station.slug, created.tracking_token)}\n\n${station.name}${station.phone ? '\n' + station.phone : ''}`,
    });
  }
  res.status(201).json({ id: created.id, token: created.tracking_token, total: created.total });
}));

// Customers who lost their link can find the order with its number and phone number
router.post('/station/:slug/lookup', wrap(async (req, res) => {
  throttle(`lookup|${req.ip}`, 15, 60 * 60 * 1000, 'Too many attempts. Please try again later.');
  const b = parse(z.object({ order_id: z.coerce.number().int().positive(), phone: z.string().min(5) }), req.body);
  const s = await stationBySlug(req.params.slug);
  const o = await one('SELECT tracking_token, customer_phone FROM orders WHERE id = $1 AND station_id = $2', [b.order_id, s.id]);
  const a = digits(o?.customer_phone), c = digits(b.phone);
  if (!o || !a || !c || !(a.endsWith(c.slice(-9)) && c.length >= 7)) throw notFound('We could not find that order. Check the number and phone number.');
  res.json({ token: o.tracking_token });
}));

router.get('/orders/:token', wrap(async (req, res) => {
  const o = await loadByToken(pool, req.params.token);
  if (!o) throw notFound('Order not found');
  delete o.station_id;
  res.json(o);
}));

router.post('/orders/:token/cancel', wrap(async (req, res) => {
  await tx(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE tracking_token = $1 FOR UPDATE', [req.params.token]);
    if (!o) throw notFound('Order not found');
    if (o.status !== 'pending') throw bad('You can only cancel an order that has not been confirmed yet. Please call the station.');
    await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [o.id]);
    await audit({ stationId: o.station_id, user: { name: `${o.customer_name} (customer)` } }, 'order_status', 'order', o.id, { status: 'pending' }, { status: 'cancelled' }, null, client);
    await notify({ stationId: o.station_id, role: 'staff', type: 'order', client, email: false, title: `Order #${o.id} was cancelled by the customer`, link: '/staff/orders' });
  });
  res.json({ ok: true });
}));

router.post('/orders/:token/proof', upload.single('file'), wrap(async (req, res) => {
  throttle(`proof|${req.ip}`, 20, 60 * 60 * 1000);
  if (!req.file) throw bad('Choose a photo or PDF of your transfer receipt');
  const row = await one(
    "UPDATE orders SET proof_url = $1, updated_at = now() WHERE tracking_token = $2 AND status NOT IN ('cancelled','completed') RETURNING id, station_id, proof_url",
    [fileUrl(req.file), req.params.token]);
  if (!row) throw notFound('Order not found, or it is already finished');
  await notify({ stationId: row.station_id, role: 'staff', type: 'order', email: false, title: `Payment proof uploaded for order #${row.id}`, link: '/staff/orders' });
  res.json({ id: row.id, proof_url: row.proof_url });
}));

export default router;
