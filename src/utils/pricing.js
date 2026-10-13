import { audit } from './audit.js';
import { notify } from './notify.js';

export async function priceAt(client, productId, ts) {
  const { rows } = await client.query(
    'SELECT price FROM price_history WHERE product_id = $1 AND effective_at <= $2 ORDER BY effective_at DESC, id DESC LIMIT 1',
    [productId, ts],
  );
  if (rows[0]) return Number(rows[0].price);
  const p = await client.query('SELECT selling_price FROM products WHERE id = $1', [productId]);
  return Number(p.rows[0]?.selling_price || 0);
}

export async function recordInitialPrice(client, product, userId) {
  await client.query(
    `INSERT INTO price_history (station_id, product_id, price, kind, effective_at, changed_by)
     VALUES ($1,$2,$3,'initial', now() - interval '1 second', $4)`,
    [product.station_id, product.id, product.selling_price, userId || null],
  );
}

// A price change takes effect immediately. Staff with a pump of that product on shift
// are asked to record the meter reading at this moment so old and new prices apply to the right litres.
export async function changePrice(client, ctx, product, newPrice) {
  const old = Number(product.selling_price);
  if (old === Number(newPrice)) return null;
  const { rows } = await client.query(
    `INSERT INTO price_history (station_id, product_id, price, old_price, kind, changed_by)
     VALUES ($1,$2,$3,$4,'change',$5) RETURNING *`,
    [product.station_id, product.id, newPrice, old, ctx.user.id],
  );
  await client.query('UPDATE products SET selling_price = $1 WHERE id = $2', [newPrice, product.id]);
  await audit(ctx, 'price_change', 'product', product.id, { price: old }, { price: newPrice }, product.name, client);

  if (product.sale_type === 'metered') {
    const { rows: staff } = await client.query(
      `SELECT DISTINCT s.user_id FROM shifts s
         JOIN shift_pumps sp ON sp.shift_id = s.id
         JOIN pumps p ON p.id = sp.pump_id
        WHERE s.station_id = $1 AND s.status = 'open' AND p.product_id = $2`,
      [product.station_id, product.id],
    );
    if (staff.length) {
      await notify({
        stationId: product.station_id, userIds: staff.map((s) => s.user_id), type: 'price_change', client, email: false,
        title: `${product.name} price changed`,
        body: `New price ${newPrice}. Record the reading on your pump now so old and new prices apply to the right litres.`,
        link: '/staff/shift',
      });
    }
  }
  return rows[0];
}
