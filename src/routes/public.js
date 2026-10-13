import { Router } from 'express';
import { many } from '../db.js';
import { wrap } from '../utils/http.js';
import { stationBySlug } from './auth.js';
import { stockStatus } from '../utils/stock.js';

const router = Router();

const publicStation = (s) => ({
  id: s.id, slug: s.slug, name: s.name, logo_url: s.logo_url, brand_color: s.brand_color, address: s.address,
  phone: s.phone, currency: s.currency, ordering_enabled: s.ordering_enabled, public_prices: s.public_prices,
  signup_open: s.signup_open, delivery_enabled: s.delivery_enabled, delivery_note: s.delivery_note,
});

router.get('/help', wrap(async (req, res) => {
  const audience = req.query.audience;
  const rows = await many(
    `SELECT id, audience, slug, title, body, video_url, sort FROM help_articles
      WHERE published AND ($1::text IS NULL OR audience = $1) ORDER BY audience, sort, id`, [audience || null]);
  res.json(rows);
}));

router.get('/station/:slug', wrap(async (req, res) => {
  res.json(publicStation(await stationBySlug(req.params.slug)));
}));

// What visitors see before logging in. Prices only appear when the station turns on public prices.
router.get('/station/:slug/catalog', wrap(async (req, res) => {
  const s = await stationBySlug(req.params.slug);
  if (!s.ordering_enabled) return res.json({ station: publicStation(s), products: [] });
  const rows = await many(
    `SELECT p.id, p.name, p.variant, p.unit, p.sale_type, p.selling_price, p.stock_qty, p.reorder_level, p.image_url, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.station_id = $1 AND p.active AND p.orderable AND p.sale_type <> 'metered'
      ORDER BY c.sort, c.name, p.name, p.variant`, [s.id]);
  const products = rows.map((p) => ({
    id: p.id, name: p.name, variant: p.variant, unit: p.unit, category: p.category, image_url: p.image_url,
    price: s.public_prices ? p.selling_price : null, availability: stockStatus(p),
  }));
  res.json({ station: publicStation(s), products });
}));

export default router;
