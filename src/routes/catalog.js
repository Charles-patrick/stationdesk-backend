import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { z, parse, wrap, bad, notFound, id, optStr } from '../utils/http.js';
import { requireAuth, staffOrAdmin, adminOnly } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { recordInitialPrice, changePrice } from '../utils/pricing.js';
import { moveProduct, stockStatus } from '../utils/stock.js';
import { upload, fileUrl } from '../services/uploads.js';

const router = Router();
router.use(requireAuth, staffOrAdmin);

const SALE_TYPES = ['metered', 'bulk', 'packaged', 'item', 'service'];

router.get('/categories', wrap(async (req, res) => {
  res.json(await many('SELECT * FROM categories WHERE station_id = $1 ORDER BY sort, name', [req.stationId]));
}));

router.post('/categories', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2), sale_type: z.enum(SALE_TYPES), sort: z.coerce.number().int().default(0) }), req.body);
  const row = await one('INSERT INTO categories (station_id, name, sale_type, sort) VALUES ($1,$2,$3,$4) RETURNING *', [req.stationId, b.name, b.sale_type, b.sort]);
  await audit(req, 'category_create', 'category', row.id, null, b);
  res.status(201).json(row);
}));

router.patch('/categories/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).optional(), sort: z.coerce.number().int().optional(), active: z.boolean().optional() }), req.body);
  const row = await one(
    `UPDATE categories SET name = COALESCE($1, name), sort = COALESCE($2, sort), active = COALESCE($3, active)
      WHERE id = $4 AND station_id = $5 RETURNING *`, [b.name, b.sort, b.active, req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

router.get('/products', wrap(async (req, res) => {
  const rows = await many(
    `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.station_id = $1 AND ($2::boolean IS NOT TRUE OR p.active)
      ORDER BY c.sort NULLS LAST, c.name, p.name, p.variant`, [req.stationId, req.query.active === '1']);
  res.json(rows.map((p) => ({ ...p, stock_status: stockStatus(p) })));
}));

const productSchema = z.object({
  name: z.string().trim().min(1), variant: optStr, category_id: id.optional().nullable(),
  sale_type: z.enum(SALE_TYPES).optional(), unit: z.string().trim().min(1).optional(),
  selling_price: z.coerce.number().min(0).default(0), cost_price: z.coerce.number().min(0).optional().nullable(),
  reorder_level: z.coerce.number().min(0).default(0), opening_stock: z.coerce.number().min(0).default(0),
  sku: optStr, orderable: z.boolean().default(false),
});

const defaultUnit = { metered: 'litre', bulk: 'drum', packaged: 'pack', item: 'piece', service: 'service' };

router.post('/products', adminOnly, wrap(async (req, res) => {
  const b = parse(productSchema, req.body);
  const product = await tx(async (client) => {
    let saleType = b.sale_type;
    if (b.category_id) {
      const cat = (await client.query('SELECT * FROM categories WHERE id = $1 AND station_id = $2', [b.category_id, req.stationId])).rows[0];
      if (!cat) throw bad('Category not found');
      saleType = saleType || cat.sale_type;
    }
    if (!saleType) throw bad('Choose a category or a sale type');
    const orderable = saleType === 'metered' ? false : b.orderable;
    const { rows: [p] } = await client.query(
      `INSERT INTO products (station_id, category_id, name, variant, sale_type, unit, selling_price, cost_price, reorder_level, sku, orderable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.stationId, b.category_id || null, b.name, b.variant, saleType, b.unit || defaultUnit[saleType], b.selling_price,
        b.cost_price ?? null, b.reorder_level, b.sku, orderable]);
    await recordInitialPrice(client, p, req.user.id);
    if (b.opening_stock > 0 && saleType !== 'metered' && saleType !== 'service') {
      await moveProduct(client, { stationId: req.stationId, productId: p.id, delta: b.opening_stock, type: 'opening', note: 'Opening stock', userId: req.user.id });
    }
    await audit(req, 'product_create', 'product', p.id, null, { name: p.name, price: p.selling_price }, null, client);
    return p;
  });
  res.status(201).json(product);
}));

router.patch('/products/:id', adminOnly, wrap(async (req, res) => {
  const b = parse(productSchema.partial().extend({ active: z.boolean().optional() }), req.body);
  const out = await tx(async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1 AND station_id = $2 FOR UPDATE', [req.params.id, req.stationId]);
    if (!p) throw notFound('Product not found');
    if (b.selling_price !== undefined && Number(b.selling_price) !== Number(p.selling_price)) {
      await changePrice(client, req, p, b.selling_price);
    }
    const orderable = p.sale_type === 'metered' ? false : b.orderable;
    const { rows: [row] } = await client.query(
      `UPDATE products SET name = COALESCE($1,name), variant = CASE WHEN $2::boolean THEN $3 ELSE variant END,
         category_id = COALESCE($4, category_id), unit = COALESCE($5, unit), cost_price = CASE WHEN $6::boolean THEN $7 ELSE cost_price END,
         reorder_level = COALESCE($8, reorder_level), sku = CASE WHEN $9::boolean THEN $10 ELSE sku END,
         orderable = COALESCE($11, orderable), active = COALESCE($12, active)
       WHERE id = $13 RETURNING *`,
      [b.name, 'variant' in req.body, b.variant, b.category_id, b.unit, 'cost_price' in req.body, b.cost_price ?? null,
        b.reorder_level, 'sku' in req.body, b.sku, orderable, b.active, p.id]);
    await audit(req, 'product_update', 'product', p.id, { name: p.name, orderable: p.orderable, active: p.active }, { name: row.name, orderable: row.orderable, active: row.active }, null, client);
    return row;
  });
  res.json(out);
}));

router.post('/products/:id/image', adminOnly, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Choose an image to upload');
  const row = await one('UPDATE products SET image_url = $1 WHERE id = $2 AND station_id = $3 RETURNING id, image_url',
    [fileUrl(req.file), req.params.id, req.stationId]);
  if (!row) throw notFound();
  res.json(row);
}));

router.get('/products/:id/prices', wrap(async (req, res) => {
  res.json(await many(
    `SELECT h.*, u.name AS changed_by_name FROM price_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.product_id = $1 AND h.station_id = $2 ORDER BY h.effective_at DESC, h.id DESC LIMIT 100`, [req.params.id, req.stationId]));
}));

router.get('/price-history', wrap(async (req, res) => {
  res.json(await many(
    `SELECT h.*, p.name, p.variant, u.name AS changed_by_name FROM price_history h
       JOIN products p ON p.id = h.product_id LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.station_id = $1 AND h.kind = 'change' ORDER BY h.effective_at DESC LIMIT 200`, [req.stationId]));
}));

// Bulk import: paste or upload rows from a spreadsheet (the frontend converts CSV to this JSON)
router.post('/products/import', adminOnly, wrap(async (req, res) => {
  const b = parse(z.object({
    rows: z.array(z.object({
      category: z.string().trim().min(1), name: z.string().trim().min(1), variant: optStr, unit: optStr,
      price: z.coerce.number().min(0), cost: z.coerce.number().min(0).optional().nullable(),
      stock: z.coerce.number().min(0).optional().default(0), reorder_level: z.coerce.number().min(0).optional().default(0),
      sale_type: z.enum(SALE_TYPES).optional(), orderable: z.union([z.boolean(), z.string()]).optional(),
    })).min(1).max(1000),
  }), req.body);
  const result = await tx(async (client) => {
    let created = 0, skipped = 0;
    const cats = new Map();
    for (const r of b.rows) {
      let cat = cats.get(r.category.toLowerCase());
      if (!cat) {
        const found = (await client.query('SELECT * FROM categories WHERE station_id = $1 AND lower(name) = lower($2)', [req.stationId, r.category])).rows[0];
        cat = found || (await client.query(
          'INSERT INTO categories (station_id, name, sale_type, sort) VALUES ($1,$2,$3,99) RETURNING *',
          [req.stationId, r.category, r.sale_type || 'item'])).rows[0];
        cats.set(r.category.toLowerCase(), cat);
      }
      const dupe = (await client.query(
        'SELECT 1 FROM products WHERE station_id = $1 AND lower(name) = lower($2) AND COALESCE(lower(variant),\'\') = COALESCE(lower($3),\'\') AND category_id = $4',
        [req.stationId, r.name, r.variant, cat.id])).rows[0];
      if (dupe) { skipped++; continue; }
      const orderable = r.orderable === true || String(r.orderable).toLowerCase() === 'yes' || String(r.orderable).toLowerCase() === 'true';
      const saleType = cat.sale_type;
      const { rows: [p] } = await client.query(
        `INSERT INTO products (station_id, category_id, name, variant, sale_type, unit, selling_price, cost_price, reorder_level, orderable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.stationId, cat.id, r.name, r.variant, saleType, r.unit || defaultUnit[saleType], r.price, r.cost ?? null, r.reorder_level, saleType === 'metered' ? false : orderable]);
      await recordInitialPrice(client, p, req.user.id);
      if (r.stock > 0 && saleType !== 'metered' && saleType !== 'service') {
        await moveProduct(client, { stationId: req.stationId, productId: p.id, delta: r.stock, type: 'opening', note: 'Opening stock (import)', userId: req.user.id });
      }
      created++;
    }
    await audit(req, 'product_import', 'product', null, null, { created, skipped }, null, client);
    return { created, skipped };
  });
  res.status(201).json(result);
}));

export default router;
