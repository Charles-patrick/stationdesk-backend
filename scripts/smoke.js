// End-to-end check of the main flows against a running API (default http://localhost:4000).
// Run the API with a freshly seeded demo station, then:  npm run test:smoke
const BASE = process.env.API_URL || 'http://localhost:4000/api';
let passed = 0;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (c, m) => { if (!c) fail(m); passed++; console.log('ok  -', m); };

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const must = async (method, path, body, token, expect = 200) => {
  const r = await call(method, path, body, token);
  if (r.status !== expect) fail(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

const login = async (username, password) => (await must('POST', '/auth/login', { slug: 'demo', username, password })).token;

const admin = await login('admin', 'Admin123!');
const ada = await login('ada', 'Staff123!');
const customer = await login('customer@example.com', 'Customer123!');
ok(admin && ada && customer, 'admin, staff and customer can log in');

const pin = await must('POST', '/auth/login', { slug: 'demo', username: 'musa', pin: '4321' });
ok(pin.token, 'staff can log in with a PIN');

const wrongPw = await call('POST', '/auth/login', { slug: 'demo', username: 'ada', password: 'nope' });
ok(wrongPw.status === 401, 'wrong password is rejected');

const pub = await must('GET', '/public/station/demo/catalog');
ok(pub.products.length > 20 && pub.products.every((p) => p.price === null), 'public catalog hides prices by default');
const cat = await must('GET', '/orders/catalog', null, customer);
ok(cat.every((p) => typeof p.price === 'number') && !cat.some((p) => p.name.includes('Petrol')), 'logged-in catalog shows prices and no fuel');

// ---- shift with a mid-shift price change ----
const avail = await must('GET', '/shifts/available-pumps', null, ada);
const pump1 = avail.find((p) => p.name === 'Pump 1');
const start = await must('POST', '/shifts/start', { pumps: [{ pump_id: pump1.id, opening_reading: pump1.current_reading }] }, ada, 201);
ok(start.id, 'staff starts a shift on Pump 1');
const dupe = await call('POST', '/shifts/start', { pumps: [] }, ada);
ok(dupe.status === 400, 'cannot start a second shift');
const musa = pin.token;
const taken = await call('POST', '/shifts/start', { pumps: [{ pump_id: pump1.id }] }, musa);
ok(taken.status === 400, 'a pump already on a shift cannot be taken');

const products = await must('GET', '/catalog/products', null, ada);
const water = products.find((p) => p.name.startsWith('Bottled water'));
const s1 = await must('POST', '/sales', { product_id: water.id, qty: 3, payment: 'cash', client_id: 'smoke-1' }, ada, 201);
const s1b = await must('POST', '/sales', { product_id: water.id, qty: 3, payment: 'cash', client_id: 'smoke-1' }, ada, 200);
ok(s1.id === s1b.id, 'repeating an offline sale does not create a duplicate');
const fuelSale = await call('POST', '/sales', { product_id: products.find((p) => p.sale_type === 'metered').id, qty: 1 }, ada);
ok(fuelSale.status === 400, 'fuel cannot be sold manually');

const pms = products.find((p) => p.name === 'Petrol (PMS)');
await must('PATCH', `/catalog/products/${pms.id}`, { selling_price: 1000 }, admin);
const cur = await must('GET', '/shifts/current', null, ada);
ok(cur.pending_readings.length === 1, 'price change asks the attendant for a pump reading');
const closeEarly = await call('POST', `/shifts/${cur.id}/close`, { pumps: [{ shift_pump_id: cur.pumps[0].id, closing_reading: 120650.5 }], cash: 0 }, ada);
ok(closeEarly.status === 400, 'cannot close before recording the price-change reading');
await must('POST', `/shifts/${cur.id}/price-readings`, { readings: [{ shift_pump_id: cur.pending_readings[0].shift_pump_id, price_history_id: cur.pending_readings[0].price_history_id, reading: 120550.5 }] }, ada);

// 100 L at 950 + 100 L at 1000 = 195,000, plus 3 water at 300 = 900
const closed = await must('POST', `/shifts/${cur.id}/close`, {
  pumps: [{ shift_pump_id: cur.pumps[0].id, closing_reading: 120650.5 }], dips: [{ tank_id: 1, litres: '' }],
  cash: 195900, transfer: 0, pos: 0,
}, ada);
ok(Math.abs(closed.expected - 195900) < 0.01, `expected cash is 195,900 (got ${closed.expected})`);
ok(closed.variance === 0 && closed.flags.length === 0, 'no variance when cash matches');
const detail = await must('GET', `/shifts/${cur.id}`, null, admin);
const pumpSales = detail.sales.filter((s) => s.source === 'pump');
ok(pumpSales.length === 2 && pumpSales[0].unit_price === 950 && pumpSales[1].unit_price === 1000, 'litres before and after the price change use the right prices');

const locked = await must('POST', `/sales/${s1.id}/void`, { reason: 'Customer returned it' }, ada);
ok(locked.requested, 'voiding a sale on a closed shift needs approval');
const appr = await must('GET', '/approvals?status=pending', null, admin);
await must('POST', `/approvals/${appr[0].id}/decide`, { approve: true, note: 'ok' }, admin);
const after = await must('GET', `/shifts/${cur.id}`, null, admin);
ok(after.sales.find((s) => s.id === s1.id).voided, 'approved void is applied');

// ---- mismatch and variance ----
const start2 = await must('POST', '/shifts/start', { pumps: [{ pump_id: pump1.id, opening_reading: 120660.5 }] }, ada, 201);
const s2 = await must('GET', `/shifts/${start2.id}`, null, ada);
ok(s2.flags.some((f) => f.type === 'meter_gap'), 'opening reading that differs from last close is flagged');
const closed2 = await must('POST', `/shifts/${start2.id}/close`, { pumps: [{ shift_pump_id: s2.pumps[0].id, closing_reading: 120700.5 }], dips: [], cash: 30000 }, ada);
ok(closed2.flags.some((f) => f.type === 'cash'), 'cash shortage is flagged');

// ---- restock, ordering ----
const drum = products.find((p) => p.name === 'Q 7000 Drum');
await must('POST', '/inventory/restock', { product_id: drum.id, qty: 4, waybill: 'WB-1' }, admin, 201);
const o = await must('POST', '/orders', { items: [{ product_id: drum.id, qty: 2 }], fulfilment: 'pickup', payment_method: 'bank_transfer' }, customer, 201);
ok(o.total === 3400000, 'order total uses current prices');
const tooMany = await call('POST', '/orders', { items: [{ product_id: drum.id, qty: 999 }] }, customer);
ok(tooMany.status === 400, 'cannot order more than is in stock');
await must('POST', `/orders/${o.id}/status`, { status: 'confirmed' }, admin);
const adminShift = await must('POST', '/shifts/start', { pumps: [] }, admin, 201);
const done = await must('POST', `/orders/${o.id}/status`, { status: 'completed' }, admin);
ok(done.points >= 0, 'order completes and posts the sale');
const after2 = (await must('GET', '/catalog/products', null, admin)).find((p) => p.id === drum.id);
ok(after2.stock_qty === 8, `stock reduced by the order (drum stock ${after2.stock_qty})`);
await must('POST', `/shifts/${adminShift.id}/close`, { pumps: [], cash: 0, transfer: 3400000 }, admin);

// ---- credit, expenses ----
const credit = await must('GET', '/credit/customers', null, admin);
const st = await must('POST', '/shifts/start', { pumps: [] }, ada, 201);
await must('POST', '/sales', { product_id: water.id, qty: 10, payment: 'credit', credit_customer_id: credit[0].id }, ada, 201);
await must('POST', '/expenses', { category: 'Generator fuel', amount: 5000, from_till: true }, ada, 201);
const led = await must('GET', `/credit/customers/${credit[0].id}`, null, admin);
ok(led.balance === 3000, 'credit sale adds to what the customer owes');
await must('POST', `/shifts/${st.id}/close`, { pumps: [], cash: -0 + 0 }, ada).catch(() => {});
const stDetail = await must('GET', `/shifts/${st.id}`, null, ada);
ok(stDetail.status === 'closed' && stDetail.expected_amount === -5000, 'till expense reduces the expected cash');

// ---- reports ----
const dash = await must('GET', '/reports/dashboard', null, admin);
ok(dash.today_sales > 0 && dash.tanks.length === 3, 'dashboard shows today\'s sales and tanks');
const month = (await must('GET', '/reports/months', null, admin))[0];
const recap = await must('GET', `/reports/monthly/${month}`, null, admin);
ok(recap.totals.revenue > 0, 'monthly recap is built');
const pdf = await fetch(`${BASE}/reports/monthly/${month}/pdf`, { headers: { Authorization: `Bearer ${admin}` } });
ok(pdf.status === 200 && (await pdf.arrayBuffer()).byteLength > 1000, 'recap downloads as PDF');
const xlsx = await fetch(`${BASE}/reports/monthly/${month}/xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
ok(xlsx.status === 200 && (await xlsx.arrayBuffer()).byteLength > 1000, 'recap downloads as Excel');
const csv = await fetch(`${BASE}/exports/sales`, { headers: { Authorization: `Bearer ${admin}` } });
ok((await csv.text()).includes('product_name'), 'sales export works');
const audit = await must('GET', '/audit', null, admin);
ok(audit.some((a) => a.action === 'price_change') && audit.some((a) => a.action === 'shift_close'), 'audit trail records price changes and shift closes');

// ---- permissions and station switches ----
const noAccess = await call('GET', '/reports/dashboard', null, ada);
ok(noAccess.status === 403, 'staff cannot open admin reports');
const custUsers = await call('GET', '/users', null, customer);
ok(custUsers.status === 403, 'customers cannot list users');
await must('PATCH', '/station', { ordering_enabled: false }, admin);
const blocked = await call('POST', '/orders', { items: [{ product_id: drum.id, qty: 1 }] }, customer);
ok(blocked.status === 400, 'orders are refused when the station turns ordering off');
await must('PATCH', '/station', { ordering_enabled: true }, admin);

const owner = await must('POST', '/auth/platform-login', { username: 'owner', password: process.env.OWNER_PASSWORD || 'ChangeMe123!' });
const stations = await must('GET', '/platform/stations', null, owner.token);
ok(stations.length >= 1, 'platform owner can list stations');
const created = await must('POST', '/platform/stations', {
  name: 'Second Station', slug: 'second', template: 'fuel_lube', admin_name: 'Second Admin', admin_username: 'admin2', admin_password: 'Admin123!',
}, owner.token, 201);
const adm2 = await must('POST', '/auth/login', { slug: 'second', username: 'admin2', password: 'Admin123!' });
const other = await must('GET', '/catalog/products', null, adm2.token);
ok(other.length === 0, 'a new station starts with its own empty catalog (data is separated)');

console.log(`\nAll ${passed} checks passed.`);
