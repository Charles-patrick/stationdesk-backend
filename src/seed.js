import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool, one, tx } from './db.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { HELP_ARTICLES } from './services/helpContent.js';
import { applyTemplate } from './services/templates.js';
import { recordInitialPrice } from './utils/pricing.js';
import { moveProduct } from './utils/stock.js';

// TotalEnergies price list (effective 1 October 2026). These are selling prices.
const DRUMS = [
  ['Q 7000 Drum', 1700000], ['Q9000 Drum', 2850000], ['Classic Drum', 1035000], ['Rubia Fleet HD300 Drum', 1126000],
  ['Rubia TIR', 1155000], ['Azolla 68 Drum', 970000], ['Azolla 46', 950000], ['Rubia S30 Drum', 1070000],
  ['Carter EP220 Drum', 1075000], ['Transtec EP140', 1200000], ['Transtec EP 90 Drum', 1110000], ['Fluid Matic DII MV', 1385000],
  ['Multis EP2 50KG Drum', 830000], ['Seriola 1510 Drum', 910000], ['Rubia Fleet 200 (SAE 40)', 1075000], ['Q5000 Drum', 1330000],
];
const KEGS = [['Fleet 3000', 135800], ['Fleet 200', 133000], ['Fleet 100', 128600], ['Azolla', 121500]];
const PACKS = {
  '5L': [['Q9000 0W30', 97000], ['Q9000 5W40', 74000], ['Q7000', 46000], ['Q5000', 30500]],
  '4L': [['Q5000', 25000], ['Classic', 22300], ['Fleet 200', 23500], ['EP 140', 25300], ['EP 90', 23400], ['Q 300', 23000]],
  '1L': [['Q9000', 20000], ['Q7000', 9800], ['Q5000', 6750], ['High Perf', 6200], ['Classic', 5900], ['Fluidmatic', 7900], ['Bulk Oil', 4800]],
};
const SHOP = [['Bottled water 75cl', 300], ['Soft drink 50cl', 400], ['Solar lamp', 8500], ['Car air freshener', 1500]];

export async function seedHelp() {
  for (const a of HELP_ARTICLES) {
    await pool.query(
      `INSERT INTO help_articles (audience, slug, title, body, sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
      [a.audience, a.slug, a.title, a.body, a.sort]);
  }
}

export async function seedOwner() {
  const exists = await one("SELECT id FROM users WHERE role = 'platform_owner' AND username = $1", [config.owner.username]);
  if (exists) return exists;
  return one(
    `INSERT INTO users (role, name, username, password_hash) VALUES ('platform_owner',$1,$2,$3) RETURNING id`,
    [config.owner.name, config.owner.username, await bcrypt.hash(config.owner.password, 10)]);
}

export async function seedDemo() {
  if (await one("SELECT id FROM stations WHERE slug = 'demo'")) return false;
  await tx(async (client) => {
    const { rows: [station] } = await client.query(
      `INSERT INTO stations (slug, name, brand_color, address, phone, email, public_prices, loyalty_enabled)
       VALUES ('demo','TotalEnergies Demo Station','#E2231A','Demo address, Nigeria','08000000000','admin@demo.test', FALSE, TRUE) RETURNING *`);
    const hash = (p) => bcrypt.hash(p, 10);
    const { rows: [admin] } = await client.query(
      `INSERT INTO users (station_id, role, name, username, email, password_hash) VALUES ($1,'admin','Demo Admin','admin','admin@demo.test',$2) RETURNING *`, [station.id, await hash('Admin123!')]);
    await client.query(
      `INSERT INTO users (station_id, role, name, username, password_hash, pin_hash) VALUES ($1,'staff','Ada Attendant','ada',$2,$3), ($1,'staff','Musa Attendant','musa',$4,$5)`,
      [station.id, await hash('Staff123!'), await hash('1234'), await hash('Staff123!'), await hash('4321')]);
    await client.query(
      `INSERT INTO users (station_id, role, name, username, email, phone, password_hash) VALUES ($1,'customer','Demo Customer','customer@example.com','customer@example.com','08011111111',$2)`,
      [station.id, await hash('Customer123!')]);
    const ctx = { stationId: station.id, user: admin };

    // Prices below are demo values. Replace them with your real pump prices.
    await applyTemplate(client, ctx, {
      template: 'full',
      fuels: [
        { key: 'pms', price: 950, reorder_level: 5000, tanks: [{ name: 'PMS Tank 1', capacity: 33000, litres: 24000 }],
          pumps: [{ name: 'Pump 1', reading: 120450.5, tank: 0 }, { name: 'Pump 2', reading: 98320.2, tank: 0 }] },
        { key: 'ago', price: 1150, reorder_level: 4000, tanks: [{ name: 'AGO Tank 1', capacity: 33000, litres: 18000 }],
          pumps: [{ name: 'Pump 3', reading: 75210.8, tank: 0 }] },
        { key: 'dpk', price: 1250, reorder_level: 1500, tanks: [{ name: 'DPK Tank 1', capacity: 10000, litres: 6000 }],
          pumps: [{ name: 'Pump 4', reading: 20310.1, tank: 0 }] },
      ],
    });
    const cats = Object.fromEntries((await client.query('SELECT id, name FROM categories WHERE station_id = $1', [station.id])).rows.map((c) => [c.name, c.id]));

    const add = async (category, saleType, name, variant, unit, price, stock, reorder, orderable) => {
      const { rows: [p] } = await client.query(
        `INSERT INTO products (station_id, category_id, name, variant, sale_type, unit, selling_price, reorder_level, orderable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [station.id, cats[category], name, variant, saleType, unit, price, reorder, orderable]);
      await recordInitialPrice(client, p, admin.id);
      if (stock > 0) await moveProduct(client, { stationId: station.id, productId: p.id, delta: stock, type: 'opening', note: 'Opening stock (demo)', userId: admin.id });
    };
    for (const [n, price] of DRUMS) await add('Lubricant Drums', 'bulk', n, null, 'drum', price, 6, 2, true);
    for (const [n, price] of KEGS) await add('Lubricant Kegs', 'bulk', n, null, 'keg', price, 10, 3, true);
    for (const [size, list] of Object.entries(PACKS)) {
      for (const [n, price] of list) await add('Lubricant Packs', 'packaged', n, size, 'pack', price, 24, 6, true);
    }
    for (const [n, price] of SHOP) await add('Miscellaneous', 'item', n, null, 'piece', price, 40, 10, false);

    await client.query(`INSERT INTO suppliers (station_id, name, phone, email) VALUES ($1,'TotalEnergies Marketing Nigeria','08000000001',NULL)`, [station.id]);
    await client.query(`INSERT INTO credit_customers (station_id, name, company, phone, credit_limit) VALUES ($1,'Sample Transport Ltd','Sample Transport Ltd','08022222222',500000)`, [station.id]);
  });
  return true;
}

export async function seedAll() {
  await migrate();
  await seedHelp();
  await seedOwner();
  console.log(`Platform owner ready: username "${config.owner.username}"`);
  if (config.seedDemo) {
    const made = await seedDemo();
    console.log(made ? 'Demo station created at /s/demo (admin / Admin123!, ada / Staff123!, customer@example.com / Customer123!)' : 'Demo station already exists.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedAll().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
