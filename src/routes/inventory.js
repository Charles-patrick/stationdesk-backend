import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, id, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { moveProduct, moveTank, stockStatus, round2 } from '../utils/stock.js';
import { upload, fileUrl } from '../services/uploads.js';
import { notify } from '../utils/notify.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

router.get('/overview', wrap(async (req, res) => {
  const products = await many(
    `SELECT p.id, p.name, p.variant, p.unit, p.sale_type, p.stock_qty, p.reorder_level, p.selling_price, p.cost_price, p.active, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.station_id = $1 AND p.active AND p.sale_type <> 'service'
      ORDER BY c.sort, c.name, p.name, p.variant`, [req.stationId]);
  const tanks = await many(
    `SELECT t.*, p.name AS product_name FROM tanks t JOIN products p ON p.id = t.product_id WHERE t.station_id = $1 AND t.active ORDER BY p.name, t.name`, [req.stationId]);
  const lastDips = await many(
    `SELECT DISTINCT ON (tank_id) tank_id, litres, variance, created_at FROM dip_readings WHERE station_id = $1 ORDER BY tank_id, created_at DESC`, [req.stationId]);
  res.json({
    products: products.map((p) => ({ ...p, stock_status: stockStatus(p) })),
    tanks: tanks.map((t) => ({ ...t, last_dip: lastDips.find((d) => d.tank_id === t.id) || null })),
  });
}));

router.get('/movements', wrap(async (req, res) => {
  const { product_id, tank_id } = req.query;
  res.json(await many(
    `SELECT m.*, p.name AS product_name, p.variant, t.name AS tank_name, u.name AS user_name FROM stock_movements m
       LEFT JOIN products p ON p.id = m.product_id LEFT JOIN tanks t ON t.id = m.tank_id LEFT JOIN users u ON u.id = m.user_id
      WHERE m.station_id = $1 AND ($2::bigint IS NULL OR m.product_id = $2) AND ($3::bigint IS NULL OR m.tank_id = $3)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, [req.stationId, product_id || null, tank_id || null]));
}));

router.post('/restock', wrap(async (req, res) => {
  const b = parse(z.object({
    product_id: id, tank_id: id.optional().nullable(), qty: z.coerce.number().positive(),
    supplier_name: optStr, cost_price: z.coerce.number().min(0).optional().nullable(),
    waybill: optStr, dip_before: z.coerce.number().min(0).optional().nullable(), dip_after: z.coerce.number().min(0).optional().nullable(), note: optStr,
  }), req.body);
  const row = await tx(async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1 AND station_id = $2', [b.product_id, req.stationId]);
    if (!p) throw bad('Product not found');
    if (p.sale_type === 'service') throw bad('Services have no stock');
    let short = null;
    if (p.sale_type === 'metered') {
      if (!b.tank_id) throw bad('Choose the tank that received the delivery');
      const t = (await client.query('SELECT * FROM tanks WHERE id = $1 AND station_id = $2 AND product_id = $3', [b.tank_id, req.stationId, p.id])).rows[0];
      if (!t) throw bad('That tank does not hold this fuel');
      if (Number(t.current_litres) + b.qty > Number(t.capacity_litres) * 1.02 && t.capacity_litres > 0) {
        throw bad(`${t.name} holds up to ${t.capacity_litres} L. That delivery would overfill it.`);
      }
      if (b.dip_before != null && b.dip_after != null) {
        short = round2(b.qty - (b.dip_after - b.dip_before));
      }
    }
    const { rows: [r] } = await client.query(
      `INSERT INTO restocks (station_id, product_id, tank_id, supplier_name, qty, cost_price, waybill, dip_before, dip_after, short_delivery, note, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.stationId, p.id, b.tank_id || null, b.supplier_name, b.qty, b.cost_price ?? null, b.waybill,
        b.dip_before ?? null, b.dip_after ?? null, short, b.note, req.user.id]);
    if (p.sale_type === 'metered') {
      await moveTank(client, { stationId: req.stationId, tankId: b.tank_id, delta: b.qty, type: 'restock', refType: 'restock', refId: r.id, note: b.waybill, userId: req.user.id });
    } else {
      await moveProduct(client, { stationId: req.stationId, productId: p.id, delta: b.qty, type: 'restock', refType: 'restock', refId: r.id, note: b.waybill, userId: req.user.id });
    }
    if (b.cost_price != null) await client.query('UPDATE products SET cost_price = $1 WHERE id = $2', [b.cost_price, p.id]);
    await audit(req, 'restock', 'restock', r.id, null, { product: p.name, qty: b.qty, waybill: b.waybill, short }, null, client);
    if (short && short > 0.5 + b.qty * 0.005) {
      await notify({ stationId: req.stationId, role: 'admin', type: 'variance', client, title: `Short delivery: ${p.name}`,
        body: `Delivery of ${b.qty} L but the tank only rose by ${round2(b.dip_after - b.dip_before)} L (short ${short} L).`, link: '/admin/stock' });
    }
    return r;
  });
  res.status(201).json(row);
}));

router.post('/restock/:id/photo', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Choose a photo to upload');
  const row = await one('UPDATE restocks SET photo_url = $1 WHERE id = $2 AND station_id = $3 RETURNING id, photo_url', [fileUrl(req.file), req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

router.get('/restocks', wrap(async (req, res) => {
  const { from, to } = req.query;
  res.json(await many(
    `SELECT r.*, p.name AS product_name, p.variant, t.name AS tank_name, u.name AS received_by_name FROM restocks r
       JOIN products p ON p.id = r.product_id LEFT JOIN tanks t ON t.id = r.tank_id LEFT JOIN users u ON u.id = r.received_by
      WHERE r.station_id = $1 AND ($2::timestamptz IS NULL OR r.created_at >= $2) AND ($3::timestamptz IS NULL OR r.created_at < $3)
      ORDER BY r.created_at DESC LIMIT 300`, [req.stationId, from || null, to || null]));
}));

router.post('/restocks/:id/void', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3) }), req.body);
  await tx(async (client) => {
    const { rows: [r] } = await client.query('SELECT * FROM restocks WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!r || r.voided) throw notFound('Restock not found');
    await client.query('UPDATE restocks SET voided = TRUE WHERE id = $1', [r.id]);
    if (r.tank_id) await moveTank(client, { stationId: req.stationId, tankId: r.tank_id, delta: -Number(r.qty), type: 'void', refType: 'restock', refId: r.id, note: b.reason, userId: req.user.id });
    else await moveProduct(client, { stationId: req.stationId, productId: r.product_id, delta: -Number(r.qty), type: 'void', refType: 'restock', refId: r.id, note: b.reason, userId: req.user.id });
    await audit(req, 'restock_void', 'restock', r.id, { qty: r.qty }, { voided: true }, b.reason, client);
  });
  res.json({ ok: true });
}));

// Damage, spillage, expiry, theft or a recount. A reason is always required.
router.post('/adjust', wrap(async (req, res) => {
  const b = parse(z.object({
    product_id: id, tank_id: id.optional().nullable(), qty: z.coerce.number().refine((n) => n !== 0, 'Enter a quantity'),
    reason: z.string().trim().min(3, 'Say why the stock is being adjusted'),
  }), req.body);
  await tx(async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1 AND station_id = $2', [b.product_id, req.stationId]);
    if (!p) throw bad('Product not found');
    if (p.sale_type === 'metered') {
      if (!b.tank_id) throw bad('Choose the tank');
      await moveTank(client, { stationId: req.stationId, tankId: b.tank_id, delta: b.qty, type: 'adjustment', note: b.reason, userId: req.user.id });
    } else {
      if (Number(p.stock_qty) + b.qty < 0) throw bad('That would take stock below zero');
      await moveProduct(client, { stationId: req.stationId, productId: p.id, delta: b.qty, type: 'adjustment', note: b.reason, userId: req.user.id });
    }
    await audit(req, 'stock_adjust', 'product', p.id, null, { qty: b.qty }, b.reason, client);
  });
  res.json({ ok: true });
}));

// A dipstick check outside of a shift close. Admins can also set the book stock to match what is in the tank.
router.post('/dip', wrap(async (req, res) => {
  const b = parse(z.object({ tank_id: id, litres: z.coerce.number().min(0), reconcile: z.boolean().optional() }), req.body);
  const out = await tx(async (client) => {
    const { rows: [t] } = await client.query('SELECT * FROM tanks WHERE id = $1 AND station_id = $2 FOR UPDATE', [b.tank_id, req.stationId]);
    if (!t) throw notFound('Tank not found');
    const variance = round2(b.litres - Number(t.current_litres));
    const { rows: [st] } = await client.query('SELECT litre_tolerance_pct FROM stations WHERE id = $1', [req.stationId]);
    const flagged = Math.abs(variance) > Math.max(2, Number(t.capacity_litres) * Number(st.litre_tolerance_pct) / 100 * 0.1);
    await client.query(
      'INSERT INTO dip_readings (station_id, tank_id, litres, book_litres, variance, flagged, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.stationId, t.id, b.litres, t.current_litres, variance, flagged, req.user.id]);
    if (b.reconcile) {
      if (req.user.role !== 'admin') throw bad('Only an admin can set book stock to match the dip');
      await moveTank(client, { stationId: req.stationId, tankId: t.id, delta: variance, type: 'adjustment', note: 'Reconciled to dip reading', userId: req.user.id });
    }
    await audit(req, 'dip_check', 'tank', t.id, { book: t.current_litres }, { dip: b.litres, variance, reconciled: !!b.reconcile }, null, client);
    return { variance, book: Number(t.current_litres), flagged };
  });
  res.json(out);
}));

router.get('/dips', wrap(async (req, res) => {
  res.json(await many(
    `SELECT d.*, t.name AS tank_name, u.name AS user_name FROM dip_readings d JOIN tanks t ON t.id = d.tank_id LEFT JOIN users u ON u.id = d.user_id
      WHERE d.station_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [req.stationId]));
}));

export default router;
