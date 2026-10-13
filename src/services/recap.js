import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { one, many, q } from '../db.js';
import { monthRange, todayRange, fmtMoney, fmtNum } from '../utils/time.js';

const SALE_SCOPE = `FROM sales s LEFT JOIN shifts sh ON sh.id = s.shift_id JOIN products p ON p.id = s.product_id LEFT JOIN categories c ON c.id = p.category_id
  WHERE s.station_id = $1 AND NOT s.voided AND (sh.id IS NULL OR sh.status = 'closed')
    AND COALESCE(sh.closed_at, s.created_at) >= $2 AND COALESCE(sh.closed_at, s.created_at) < $3`;

function prevMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export async function buildRecap(stationId, month) {
  const station = await one('SELECT * FROM stations WHERE id = $1', [stationId]);
  const tz = station.timezone;
  const { start, end } = monthRange(month, tz);
  const p = [stationId, start, end];

  const totals = await one(
    `SELECT COALESCE(SUM(s.amount),0) AS revenue,
            COALESCE(SUM(s.qty) FILTER (WHERE p.sale_type = 'metered'),0) AS litres,
            COALESCE(SUM(s.qty) FILTER (WHERE p.sale_type <> 'metered'),0) AS units,
            COALESCE(SUM(s.amount) FILTER (WHERE s.source = 'order'),0) AS order_revenue,
            COALESCE(SUM(s.amount) FILTER (WHERE s.payment = 'credit'),0) AS credit_sales,
            COALESCE(SUM(s.amount - s.qty * p.cost_price) FILTER (WHERE p.cost_price IS NOT NULL),0) AS profit_known,
            COALESCE(SUM(s.amount) FILTER (WHERE p.cost_price IS NOT NULL),0) AS revenue_with_cost
       ${SALE_SCOPE}`, p);
  const byCategory = await many(
    `SELECT COALESCE(c.name,'Other') AS name, SUM(s.amount) AS revenue, SUM(s.qty) AS qty ${SALE_SCOPE} GROUP BY 1 ORDER BY revenue DESC`, p);
  const byProduct = await many(
    `SELECT s.product_name AS name, SUM(s.qty) AS qty, SUM(s.amount) AS revenue ${SALE_SCOPE} GROUP BY s.product_name ORDER BY revenue DESC`, p);
  const daily = await many(
    `SELECT to_char((COALESCE(sh.closed_at, s.created_at)) AT TIME ZONE $4, 'YYYY-MM-DD') AS date, SUM(s.amount) AS revenue
       ${SALE_SCOPE} GROUP BY 1 ORDER BY 1`, [...p, tz]);
  const expenses = await many(
    `SELECT category, SUM(amount) AS amount FROM expenses WHERE station_id = $1 AND NOT voided
       AND spent_at >= ($2::timestamptz AT TIME ZONE $4)::date AND spent_at < ($3::timestamptz AT TIME ZONE $4)::date GROUP BY category ORDER BY amount DESC`,
    [stationId, start, end, tz]);
  const shifts = await one(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(variance_amount) FILTER (WHERE variance_amount < 0),0) AS shortages,
            COALESCE(SUM(variance_amount) FILTER (WHERE variance_amount > 0),0) AS surpluses,
            COUNT(*) FILTER (WHERE jsonb_array_length(flags) > 0)::int AS flagged
       FROM shifts WHERE station_id = $1 AND status = 'closed' AND closed_at >= $2 AND closed_at < $3`, p);
  const notClosed = await one("SELECT COUNT(*)::int AS n FROM shifts WHERE station_id = $1 AND status = 'open'", [stationId]);
  const restocks = await one(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(qty * COALESCE(cost_price,0)),0) AS value FROM restocks
      WHERE station_id = $1 AND NOT voided AND created_at >= $2 AND created_at < $3`, p);
  const losses = await one(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(-m.qty * COALESCE(pr.cost_price, pr.selling_price)),0) AS value
       FROM stock_movements m JOIN products pr ON pr.id = m.product_id
      WHERE m.station_id = $1 AND m.type IN ('adjustment','meter_gap') AND m.qty < 0 AND m.created_at >= $2 AND m.created_at < $3`, p);
  const orders = await one(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS value FROM orders
      WHERE station_id = $1 AND status = 'completed' AND updated_at >= $2 AND updated_at < $3`, p);
  const owed = await one(
    `SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN -amount ELSE amount END),0) AS total FROM credit_entries WHERE station_id = $1 AND NOT voided`, [stationId]);

  const prevKey = prevMonth(month);
  const pr = monthRange(prevKey, tz);
  const prev = await one(`SELECT COALESCE(SUM(s.amount),0) AS revenue ${SALE_SCOPE}`, [stationId, pr.start, pr.end]);

  const expenseTotal = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const revenue = Number(totals.revenue);
  const profitKnown = Number(totals.profit_known);
  return {
    month, station: { name: station.name, currency: station.currency, timezone: tz },
    period: { start, end },
    totals: {
      revenue, litres: Number(totals.litres), units: Number(totals.units), order_revenue: Number(totals.order_revenue), credit_sales: Number(totals.credit_sales),
      expenses: expenseTotal, gross_profit_estimate: profitKnown,
      profit_coverage_pct: revenue > 0 ? Math.round((Number(totals.revenue_with_cost) / revenue) * 100) : 0,
      net_after_expenses: profitKnown - expenseTotal,
      previous_revenue: Number(prev.revenue),
      change_pct: Number(prev.revenue) > 0 ? Math.round(((revenue - Number(prev.revenue)) / Number(prev.revenue)) * 1000) / 10 : null,
    },
    by_category: byCategory.map((r) => ({ ...r, revenue: Number(r.revenue), qty: Number(r.qty) })),
    top_products: byProduct.slice(0, 10).map((r) => ({ ...r, revenue: Number(r.revenue), qty: Number(r.qty) })),
    slowest_products: byProduct.slice(-5).reverse().map((r) => ({ ...r, revenue: Number(r.revenue), qty: Number(r.qty) })),
    all_products: byProduct.map((r) => ({ ...r, revenue: Number(r.revenue), qty: Number(r.qty) })),
    daily: daily.map((r) => ({ date: r.date, revenue: Number(r.revenue) })),
    expenses: expenses.map((r) => ({ category: r.category, amount: Number(r.amount) })),
    shifts: { count: shifts.count, flagged: shifts.flagged, shortages: Number(shifts.shortages), surpluses: Number(shifts.surpluses), still_open: notClosed.n },
    restocks: { count: restocks.count, value: Number(restocks.value) },
    losses: { count: losses.count, value: Number(losses.value) },
    orders: { count: orders.count, value: Number(orders.value) },
    credit_outstanding: Number(owed.total),
    generated_at: new Date().toISOString(),
  };
}

export async function getRecap(stationId, month, { refresh = false } = {}) {
  if (!refresh) {
    const saved = await one('SELECT data FROM monthly_recaps WHERE station_id = $1 AND month = $2', [stationId, month]);
    if (saved) return saved.data;
  }
  const data = await buildRecap(stationId, month);
  await q(
    `INSERT INTO monthly_recaps (station_id, month, data) VALUES ($1,$2,$3)
     ON CONFLICT (station_id, month) DO UPDATE SET data = EXCLUDED.data, generated_at = now()`, [stationId, month, JSON.stringify(data)]);
  return data;
}

export function recapPdf(data) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const cur = data.station.currency;
    const money = (n) => fmtMoney(n, cur).replace(/\u00a0/g, ' ');
    const t = data.totals;

    doc.fontSize(20).font('Helvetica-Bold').text(data.station.name);
    doc.fontSize(12).font('Helvetica').fillColor('#555').text(`Monthly recap for ${data.month}`).moveDown();
    doc.fillColor('#000');

    const line = (label, value) => {
      doc.font('Helvetica').fontSize(11).text(label, 48, doc.y, { continued: true, width: 300 });
      doc.font('Helvetica-Bold').text(String(value), { align: 'right' });
    };
    doc.font('Helvetica-Bold').fontSize(13).text('Summary').moveDown(0.3);
    line('Total sales', money(t.revenue));
    line('Fuel sold (litres)', fmtNum(t.litres));
    line('Other items sold (units)', fmtNum(t.units));
    line('Online orders completed', `${data.orders.count} (${money(data.orders.value)})`);
    line('Sales on credit', money(t.credit_sales));
    line('Expenses', money(t.expenses));
    if (t.profit_coverage_pct > 0) {
      line(`Gross profit estimate (${t.profit_coverage_pct}% of sales have a cost price)`, money(t.gross_profit_estimate));
      line('Estimated profit after expenses', money(t.net_after_expenses));
    }
    line('Compared with last month', t.change_pct === null ? 'No earlier data' : `${t.change_pct > 0 ? '+' : ''}${t.change_pct}%`);
    doc.moveDown();

    doc.font('Helvetica-Bold').fontSize(13).text('Shifts and cash').moveDown(0.3);
    line('Shifts closed', data.shifts.count);
    line('Shifts with flags', data.shifts.flagged);
    line('Cash shortages', money(data.shifts.shortages));
    line('Cash surpluses', money(data.shifts.surpluses));
    if (data.shifts.still_open) line('Shifts not yet closed', data.shifts.still_open);
    line('Stock losses and adjustments', `${data.losses.count} (${money(data.losses.value)})`);
    line('Restocks received', `${data.restocks.count} (${money(data.restocks.value)})`);
    line('Owed by credit customers now', money(data.credit_outstanding));
    doc.moveDown();

    const table = (title, rows, cols) => {
      if (!rows.length) return;
      doc.font('Helvetica-Bold').fontSize(13).text(title).moveDown(0.3);
      for (const r of rows) {
        if (doc.y > 760) doc.addPage();
        doc.font('Helvetica').fontSize(10).text(cols[0](r), 48, doc.y, { continued: true, width: 300 });
        doc.text(cols[1](r), { align: 'right' });
      }
      doc.moveDown();
    };
    table('Sales by category', data.by_category, [(r) => r.name, (r) => money(r.revenue)]);
    table('Best sellers', data.top_products, [(r) => `${r.name} (${fmtNum(r.qty)})`, (r) => money(r.revenue)]);
    table('Slowest sellers', data.slowest_products, [(r) => `${r.name} (${fmtNum(r.qty)})`, (r) => money(r.revenue)]);
    table('Expenses', data.expenses, [(r) => r.category, (r) => money(r.amount)]);
    doc.end();
  });
}

export async function recapXlsx(data) {
  const wb = new ExcelJS.Workbook();
  const t = data.totals;
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 44 }, { width: 22 }];
  [
    ['Station', data.station.name], ['Month', data.month], ['Total sales', t.revenue], ['Fuel sold (litres)', t.litres],
    ['Other items sold (units)', t.units], ['Online orders', data.orders.count], ['Online order value', data.orders.value],
    ['Sales on credit', t.credit_sales], ['Expenses', t.expenses], ['Gross profit estimate', t.gross_profit_estimate],
    ['Share of sales with a cost price (%)', t.profit_coverage_pct], ['Estimated profit after expenses', t.net_after_expenses],
    ['Last month sales', t.previous_revenue], ['Change vs last month (%)', t.change_pct],
    ['Shifts closed', data.shifts.count], ['Shifts with flags', data.shifts.flagged], ['Cash shortages', data.shifts.shortages],
    ['Cash surpluses', data.shifts.surpluses], ['Stock losses', data.losses.value], ['Restock value', data.restocks.value],
    ['Owed by credit customers', data.credit_outstanding],
  ].forEach((r) => sum.addRow(r));
  sum.getColumn(1).font = { bold: true };
  const add = (name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.h, key: c.k, width: c.w || 20 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
  };
  add('Products', [{ h: 'Product', k: 'name', w: 36 }, { h: 'Quantity', k: 'qty' }, { h: 'Sales', k: 'revenue' }], data.all_products);
  add('Categories', [{ h: 'Category', k: 'name', w: 30 }, { h: 'Quantity', k: 'qty' }, { h: 'Sales', k: 'revenue' }], data.by_category);
  add('Daily sales', [{ h: 'Date', k: 'date' }, { h: 'Sales', k: 'revenue' }], data.daily);
  add('Expenses', [{ h: 'Category', k: 'category', w: 30 }, { h: 'Amount', k: 'amount' }], data.expenses);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildDailySummary(station) {
  const { start, end } = todayRange(station.timezone);
  const sums = await one(
    `SELECT COALESCE(SUM(amount),0) AS revenue, COALESCE(SUM(qty) FILTER (WHERE source = 'pump'),0) AS litres, COUNT(*)::int AS lines
       FROM sales WHERE station_id = $1 AND NOT voided AND created_at >= $2 AND created_at < $3`, [station.id, start, end]);
  const shifts = await one(
    `SELECT COUNT(*)::int AS closed, COALESCE(SUM(variance_amount),0) AS variance, COUNT(*) FILTER (WHERE jsonb_array_length(flags) > 0)::int AS flagged
       FROM shifts WHERE station_id = $1 AND status = 'closed' AND closed_at >= $2 AND closed_at < $3`, [station.id, start, end]);
  const open = await one("SELECT COUNT(*)::int AS n FROM shifts WHERE station_id = $1 AND status = 'open'", [station.id]);
  const low = await many("SELECT name, variant, stock_qty, unit FROM products WHERE station_id = $1 AND active AND reorder_level > 0 AND stock_qty <= reorder_level AND sale_type <> 'service'", [station.id]);
  const pending = await one("SELECT COUNT(*)::int AS n FROM orders WHERE station_id = $1 AND status IN ('pending','confirmed','ready')", [station.id]);
  const exp = await one("SELECT COALESCE(SUM(e.amount),0) AS total FROM expenses e WHERE e.station_id = $1 AND NOT e.voided AND e.created_at >= $2 AND e.created_at < $3", [station.id, start, end]);
  const cur = station.currency;
  const text = [
    `${station.name}: summary for today`,
    `Sales: ${fmtMoney(sums.revenue, cur)}`,
    `Fuel sold: ${fmtNum(sums.litres)} litres`,
    `Expenses: ${fmtMoney(exp.total, cur)}`,
    `Shifts closed: ${shifts.closed}${open.n ? ` (${open.n} still open)` : ''}`,
    `Cash difference across closed shifts: ${fmtMoney(shifts.variance, cur)}${shifts.flagged ? ` (${shifts.flagged} flagged)` : ''}`,
    `Orders waiting: ${pending.n}`,
    low.length ? `Low stock: ${low.map((l) => `${l.name}${l.variant ? ' ' + l.variant : ''} (${l.stock_qty} ${l.unit})`).join(', ')}` : 'Low stock: none',
  ].join('\n');
  return { text, sums, shifts, low, pending: pending.n };
}
