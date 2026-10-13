import { notify } from './notify.js';

const r2 = (n) => Math.round(n * 100) / 100;
export const round2 = r2;

// After any stock change, warn admins once when an item drops to its reorder level.
export async function checkLow(client, product) {
  if (!product.reorder_level || product.reorder_level <= 0) return;
  const low = Number(product.stock_qty) <= Number(product.reorder_level);
  if (low && !product.low_notified) {
    await client.query('UPDATE products SET low_notified = TRUE WHERE id = $1', [product.id]);
    await notify({
      stationId: product.station_id, role: 'admin', type: 'low_stock', client,
      title: `Low stock: ${product.name}${product.variant ? ' ' + product.variant : ''}`,
      body: `Only ${product.stock_qty} ${product.unit} left (reorder level ${product.reorder_level}).`,
      link: '/admin/stock',
    });
  } else if (!low && product.low_notified) {
    await client.query('UPDATE products SET low_notified = FALSE WHERE id = $1', [product.id]);
  }
}

// Change stock of a counted product (drums, kegs, packs, items). Positive delta adds stock.
export async function moveProduct(client, { stationId, productId, delta, type, refType, refId, note, userId }) {
  const { rows } = await client.query(
    'UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 AND station_id = $3 RETURNING *',
    [delta, productId, stationId],
  );
  const p = rows[0];
  if (!p) throw new Error('Product not found for stock change');
  await client.query(
    `INSERT INTO stock_movements (station_id, product_id, type, qty, balance_after, ref_type, ref_id, note, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [stationId, productId, type, delta, p.stock_qty, refType || null, refId || null, note || null, userId || null],
  );
  await checkLow(client, p);
  return p;
}

// Change the book litres in a tank. The fuel product's total stock is the sum of its tanks.
export async function moveTank(client, { stationId, tankId, delta, type, refType, refId, note, userId }) {
  const { rows } = await client.query(
    'UPDATE tanks SET current_litres = current_litres + $1 WHERE id = $2 AND station_id = $3 RETURNING *',
    [delta, tankId, stationId],
  );
  const t = rows[0];
  if (!t) throw new Error('Tank not found for stock change');
  await client.query(
    `INSERT INTO stock_movements (station_id, product_id, tank_id, type, qty, balance_after, ref_type, ref_id, note, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [stationId, t.product_id, tankId, type, delta, t.current_litres, refType || null, refId || null, note || null, userId || null],
  );
  const { rows: pr } = await client.query(
    `UPDATE products SET stock_qty = COALESCE((SELECT SUM(current_litres) FROM tanks WHERE product_id = $1 AND active), 0)
     WHERE id = $1 RETURNING *`,
    [t.product_id],
  );
  if (pr[0]) await checkLow(client, pr[0]);
  return t;
}

export const stockStatus = (p) => {
  const qty = Number(p.stock_qty);
  if (p.sale_type === 'service') return 'in_stock';
  if (qty <= 0) return 'out';
  if (p.reorder_level > 0 && qty <= p.reorder_level) return 'low';
  return 'in_stock';
};
