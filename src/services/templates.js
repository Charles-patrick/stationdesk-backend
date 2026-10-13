import { audit } from '../utils/audit.js';
import { recordInitialPrice } from '../utils/pricing.js';
import { bad } from '../utils/http.js';

export const FUELS = {
  pms: { name: 'Petrol (PMS)', code: 'PMS' },
  ago: { name: 'Diesel (AGO)', code: 'AGO' },
  dpk: { name: 'Kerosene (DPK)', code: 'DPK' },
};

export const TEMPLATES = {
  fuel: { label: 'Fuel only', lubes: false, shop: false },
  fuel_lube: { label: 'Fuel and lubricants', lubes: true, shop: false },
  fuel_shop: { label: 'Fuel and shop', lubes: false, shop: true },
  full: { label: 'Fuel, lubricants and shop', lubes: true, shop: true },
};

async function category(client, stationId, name, sale_type, sort) {
  const { rows } = await client.query(
    `INSERT INTO categories (station_id, name, sale_type, sort) VALUES ($1,$2,$3,$4)
     ON CONFLICT (station_id, name) DO UPDATE SET active = TRUE RETURNING *`, [stationId, name, sale_type, sort]);
  return rows[0];
}

// Creates the standard categories for a template and, optionally, fuel products with tanks and pumps.
export async function applyTemplate(client, ctx, { template = 'full', fuels = [] }) {
  const t = TEMPLATES[template];
  if (!t) throw bad('Unknown template');
  const stationId = ctx.stationId;
  const fuelCat = await category(client, stationId, 'Fuel', 'metered', 1);
  if (t.lubes) {
    await category(client, stationId, 'Lubricant Drums', 'bulk', 2);
    await category(client, stationId, 'Lubricant Kegs', 'bulk', 3);
    await category(client, stationId, 'Lubricant Packs', 'packaged', 4);
  }
  if (t.shop) await category(client, stationId, 'Miscellaneous', 'item', 5);

  const created = [];
  for (const f of fuels) {
    const def = FUELS[f.key];
    if (!def) throw bad('Unknown fuel type');
    const price = Number(f.price || 0);
    const { rows: [product] } = await client.query(
      `INSERT INTO products (station_id, category_id, name, sale_type, unit, selling_price, reorder_level, sku)
       VALUES ($1,$2,$3,'metered','litre',$4,$5,$6) RETURNING *`,
      [stationId, fuelCat.id, def.name, price, Number(f.reorder_level || 0), def.code]);
    await recordInitialPrice(client, product, ctx.user?.id);
    const tankIds = [];
    for (const tk of f.tanks || []) {
      const { rows: [tank] } = await client.query(
        'INSERT INTO tanks (station_id, product_id, name, capacity_litres, current_litres) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [stationId, product.id, tk.name, Number(tk.capacity || 0), Number(tk.litres || 0)]);
      tankIds.push(tank.id);
      if (Number(tk.litres || 0) > 0) {
        await client.query(
          `INSERT INTO stock_movements (station_id, product_id, tank_id, type, qty, balance_after, note, user_id)
           VALUES ($1,$2,$3,'opening',$4,$4,'Opening stock',$5)`, [stationId, product.id, tank.id, Number(tk.litres), ctx.user?.id || null]);
      }
    }
    for (const pu of f.pumps || []) {
      await client.query(
        'INSERT INTO pumps (station_id, product_id, tank_id, name, current_reading) VALUES ($1,$2,$3,$4,$5)',
        [stationId, product.id, tankIds[pu.tank ?? 0] || null, pu.name, Number(pu.reading || 0)]);
    }
    await client.query(
      'UPDATE products SET stock_qty = COALESCE((SELECT SUM(current_litres) FROM tanks WHERE product_id = $1),0) WHERE id = $1', [product.id]);
    created.push(product.name);
  }
  await audit(ctx, 'station_setup', 'station', stationId, null, { template, fuels: created }, null, client);
  return created;
}
