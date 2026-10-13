import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, id, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { moveProduct, moveTank } from '../utils/stock.js';
import { sendEmail } from '../services/email.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

router.get('/', wrap(async (req, res) => {
  res.json(await many('SELECT * FROM suppliers WHERE station_id = $1 ORDER BY active DESC, name', [req.stationId]));
}));
const supSchema = z.object({ name: z.string().trim().min(2), phone: optStr, email: optStr, notes: optStr });
router.post('/', adminOnly, wrap(async (req, res) => {
  const b = parse(supSchema, req.body);
  res.status(201).json(await one('INSERT INTO suppliers (station_id, name, phone, email, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.stationId, b.name, b.phone, b.email, b.notes]));
}));
router.patch('/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(supSchema.partial().extend({ active: z.boolean().optional() }), req.body);
  const row = await one(
    `UPDATE suppliers SET name = COALESCE($1,name), phone = COALESCE($2,phone), email = COALESCE($3,email), notes = COALESCE($4,notes), active = COALESCE($5,active)
      WHERE id = $6 AND station_id = $7 RETURNING *`, [b.name, b.phone, b.email, b.notes, b.active, req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

// ---- Purchase orders ----
const poSelect = `
  SELECT po.*, s.name AS supplier_name, s.email AS supplier_email,
    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'product_id', i.product_id, 'tank_id', i.tank_id, 'qty', i.qty, 'unit_cost', i.unit_cost,
       'name', p.name || COALESCE(' ' || p.variant, ''), 'unit', p.unit) ORDER BY i.id)
       FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_order_id = po.id), '[]') AS items
  FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id`;

router.get('/purchase-orders', wrap(async (req, res) => {
  res.json(await many(`${poSelect} WHERE po.station_id = $1 ORDER BY po.created_at DESC LIMIT 100`, [req.stationId]));
}));

router.post('/purchase-orders', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({
    supplier_id: id.optional().nullable(), note: optStr,
    items: z.array(z.object({ product_id: id, tank_id: id.optional().nullable(), qty: z.coerce.number().positive(), unit_cost: z.coerce.number().min(0).optional().nullable() })).min(1),
  }), req.body);
  const out = await tx(async (client) => {
    const { rows: [po] } = await client.query('INSERT INTO purchase_orders (station_id, supplier_id, note, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [req.stationId, b.supplier_id || null, b.note, req.user.id]);
    for (const it of b.items) {
      const p = (await client.query('SELECT id FROM products WHERE id = $1 AND station_id = $2', [it.product_id, req.stationId])).rows[0];
      if (!p) throw bad('Product not found');
      await client.query('INSERT INTO purchase_order_items (purchase_order_id, product_id, tank_id, qty, unit_cost) VALUES ($1,$2,$3,$4,$5)', [po.id, it.product_id, it.tank_id || null, it.qty, it.unit_cost ?? null]);
    }
    await audit(req, 'po_create', 'purchase_order', po.id, null, { items: b.items.length }, null, client);
    return po;
  });
  res.status(201).json(await one(`${poSelect} WHERE po.id = $1`, [out.id]));
}));

router.post('/purchase-orders/:id/send', adminOnly, wrap(async (req, res) => {
  const po = await one(`${poSelect} WHERE po.id = $1 AND po.station_id = $2`, [req.params.id, req.stationId]);
  if (!po) throw notFound();
  if (po.status !== 'draft' && po.status !== 'sent') throw bad(`This order is already ${po.status}`);
  const station = await one('SELECT name FROM stations WHERE id = $1', [req.stationId]);
  let emailed = false;
  if (po.supplier_email) {
    emailed = await sendEmail({
      to: po.supplier_email, subject: `Purchase order #${po.id} from ${station.name}`,
      text: `Hello ${po.supplier_name},\n\nPlease supply:\n${po.items.map((i) => `- ${i.qty} ${i.unit} of ${i.name}`).join('\n')}\n\n${po.note || ''}\n\nThank you,\n${station.name}`,
    });
  }
  await one("UPDATE purchase_orders SET status = 'sent' WHERE id = $1 RETURNING id", [po.id]);
  await audit(req, 'po_send', 'purchase_order', po.id, null, { emailed });
  res.json({ ok: true, emailed });
}));

router.post('/purchase-orders/:id/receive', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ waybill: optStr, received: z.array(z.object({ item_id: id, qty: z.coerce.number().min(0) })).optional() }), req.body);
  await tx(async (client) => {
    const { rows: [po] } = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!po) throw notFound();
    if (po.status === 'received' || po.status === 'cancelled') throw bad(`This order is already ${po.status}`);
    const items = (await client.query('SELECT i.*, p.sale_type FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE purchase_order_id = $1', [po.id])).rows;
    const override = new Map((b.received || []).map((r) => [r.item_id, r.qty]));
    for (const it of items) {
      const qty = override.has(it.id) ? override.get(it.id) : Number(it.qty);
      if (qty <= 0) continue;
      if (it.sale_type === 'metered' && !it.tank_id) throw bad('Fuel items need a tank before they can be received');
      const { rows: [r] } = await client.query(
        `INSERT INTO restocks (station_id, product_id, tank_id, supplier_id, qty, cost_price, waybill, purchase_order_id, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.stationId, it.product_id, it.tank_id, po.supplier_id, qty, it.unit_cost, b.waybill, po.id, req.user.id]);
      if (it.sale_type === 'metered') await moveTank(client, { stationId: req.stationId, tankId: it.tank_id, delta: qty, type: 'restock', refType: 'restock', refId: r.id, note: `PO #${po.id}`, userId: req.user.id });
      else await moveProduct(client, { stationId: req.stationId, productId: it.product_id, delta: qty, type: 'restock', refType: 'restock', refId: r.id, note: `PO #${po.id}`, userId: req.user.id });
    }
    await client.query("UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = $1", [po.id]);
    await audit(req, 'po_receive', 'purchase_order', po.id, null, { waybill: b.waybill }, null, client);
  });
  res.json({ ok: true });
}));

router.post('/purchase-orders/:id/cancel', adminOnly, wrap(async (req, res) => {
  const row = await one("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1 AND station_id = $2 AND status IN ('draft','sent') RETURNING id", [req.params.id, req.stationId]);
  if (!row) throw bad('This order cannot be cancelled');
  await audit(req, 'po_cancel', 'purchase_order', row.id);
  res.json({ ok: true });
}));

export default router;
