// End-to-end check of the main flows against a running API (default http://localhost:4000).
// Run it against a freshly set up TEST database:  npm run test:smoke
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
const adminLogin = async () => (await must('POST', '/auth/login', { email: 'admin@demo.test', password: 'Admin123!' })).token;
const staffLogin = async (u, p) => (await must('POST', '/auth/staff-login', { slug: 'demo', username: u, password: p })).token;

const admin = await adminLogin();
const ada = await staffLogin('ada', 'Staff123!');
ok(admin && ada, 'admin logs in with email, staff with station code and username');
const musa = (await must('POST', '/auth/staff-login', { slug: 'demo', username: 'musa', pin: '4321' })).token;
ok(musa, 'staff can log in with a PIN');
ok((await call('POST', '/auth/login', { email: 'admin@demo.test', password: 'nope' })).status === 401, 'wrong admin password is rejected');
ok((await call('POST', '/auth/staff-login', { slug: 'demo', username: 'admin', password: 'Admin123!' })).status === 401, 'admins cannot use the staff login');
ok((await call('POST', '/auth/staff-login', { slug: 'nowhere', username: 'ada', password: 'Staff123!' })).status === 401, 'unknown station code is rejected');

// ---- public store: prices always visible, no fuel ----
const cat = await must('GET', '/public/station/demo/catalog');
ok(cat.products.length > 20 && cat.products.every((p) => typeof p.price === 'number'), 'store shows prices without any login');
ok(!cat.products.some((p) => /Petrol|Diesel|Kerosene/.test(p.name)), 'fuel cannot be ordered online');
const drum = cat.products.find((p) => p.name === 'Q 7000 Drum');

// ---- admins have no shifts and do not record sales ----
const adminShift = await call('POST', '/shifts/start', { pumps: [] }, admin);
ok(adminShift.status === 400, 'admins cannot start a shift');
const products = await must('GET', '/catalog/products', null, ada);
const water = products.find((p) => p.name.startsWith('Bottled water'));
const adminSale = await call('POST', '/sales', { product_id: water.id, qty: 1 }, admin);
ok(adminSale.status === 400, 'admins do not record sales');
ok((await call('POST', '/sales', { product_id: water.id, qty: 1 }, ada)).status === 400, 'staff cannot sell before starting a shift');

// ---- shift with a mid-shift price change ----
const avail = await must('GET', '/shifts/available-pumps', null, ada);
const pump1 = avail.find((p) => p.name === 'Pump 1');
const start = await must('POST', '/shifts/start', { pumps: [{ pump_id: pump1.id, opening_reading: pump1.current_reading }] }, ada, 201);
ok(start.id, 'staff starts a shift on Pump 1');
ok((await call('POST', '/shifts/start', { pumps: [{ pump_id: pump1.id }] }, musa)).status === 400, 'a pump already on a shift cannot be taken');
const s1 = await must('POST', '/sales', { product_id: water.id, qty: 3, payment: 'cash', client_id: 'smoke-1' }, ada, 201);
const s1b = await must('POST', '/sales', { product_id: water.id, qty: 3, payment: 'cash', client_id: 'smoke-1' }, ada, 200);
ok(s1.id === s1b.id, 'repeating an offline sale does not create a duplicate');
ok((await call('POST', '/sales', { product_id: water.id, qty: 1, payment: 'credit' }, ada)).status === 400, 'credit sales no longer exist');

const pms = products.find((p) => p.name === 'Petrol (PMS)');
await must('PATCH', `/catalog/products/${pms.id}`, { selling_price: 1000 }, admin);
const cur = await must('GET', '/shifts/current', null, ada);
ok(cur.pending_readings.length === 1, 'price change asks the attendant for a pump reading');
ok((await call('POST', `/shifts/${cur.id}/close`, { pumps: [{ shift_pump_id: cur.pumps[0].id, closing_reading: 120650.5 }], cash: 0 }, ada)).status === 400, 'cannot close before recording the price-change reading');
await must('POST', `/shifts/${cur.id}/price-readings`, { readings: [{ shift_pump_id: cur.pending_readings[0].shift_pump_id, price_history_id: cur.pending_readings[0].price_history_id, reading: 120550.5 }] }, ada);
const closed = await must('POST', `/shifts/${cur.id}/close`, { pumps: [{ shift_pump_id: cur.pumps[0].id, closing_reading: 120650.5 }], dips: [{ tank_id: 1, litres: '' }], cash: 195900, transfer: 0, pos: 0 }, ada);
ok(Math.abs(closed.expected - 195900) < 0.01, `expected cash is 195,900 (got ${closed.expected})`);
ok(closed.variance === 0 && closed.flags.length === 0, 'no variance when cash matches');
const detail = await must('GET', `/shifts/${cur.id}`, null, admin);
const pumpSales = detail.sales.filter((s) => s.source === 'pump');
ok(pumpSales.length === 2 && pumpSales[0].unit_price === 950 && pumpSales[1].unit_price === 1000, 'litres before and after the price change use the right prices');
ok((await must('POST', `/sales/${s1.id}/void`, { reason: 'Customer returned it' }, ada)).requested, 'voiding a sale on a closed shift needs approval');
const appr = await must('GET', '/approvals?status=pending', null, admin);
await must('POST', `/approvals/${appr[0].id}/decide`, { approve: true, note: 'ok' }, admin);
ok((await must('GET', `/shifts/${cur.id}`, null, admin)).sales.find((s) => s.id === s1.id).voided, 'approved void is applied');

// ---- mismatch and variance ----
const start2 = await must('POST', '/shifts/start', { pumps: [{ pump_id: pump1.id, opening_reading: 120660.5 }] }, ada, 201);
const s2 = await must('GET', `/shifts/${start2.id}`, null, ada);
ok(s2.flags.some((f) => f.type === 'meter_gap'), 'opening reading that differs from last close is flagged');
const closed2 = await must('POST', `/shifts/${start2.id}/close`, { pumps: [{ shift_pump_id: s2.pumps[0].id, closing_reading: 120700.5 }], dips: [], cash: 30000 }, ada);
ok(closed2.flags.some((f) => f.type === 'cash'), 'cash shortage is flagged');

// ---- customer orders without an account ----
await must('POST', '/inventory/restock', { product_id: drum.id, qty: 4, waybill: 'WB-1' }, admin, 201);
const order = { customer_name: 'Ngozi Test', customer_phone: '08031234567', customer_email: '', items: [{ product_id: drum.id, qty: 2 }], fulfilment: 'pickup' };
ok((await call('POST', '/public/station/demo/orders', { ...order, website: 'spam' })).status === 400, 'the spam trap rejects bots');
ok((await call('POST', '/public/station/demo/orders', { ...order, customer_phone: '1' })).status === 400, 'a phone number is required');
const o = await must('POST', '/public/station/demo/orders', order, null, 201);
ok(o.token && o.id, 'a customer can order with just a name and phone number');
const tracked = await must('GET', `/public/orders/${o.token}`);
ok(tracked.total === 3400000 && tracked.status === 'pending', 'the tracking link shows the order');
ok((await call('POST', '/public/station/demo/orders', { ...order, items: [{ product_id: drum.id, qty: 999 }] })).status === 400, 'cannot order more than is in stock');
const look = await must('POST', '/public/station/demo/lookup', { order_id: o.id, phone: '0803 123 4567' });
ok(look.token === o.token, 'an order can be found again with its number and phone');
ok((await call('POST', '/public/station/demo/lookup', { order_id: o.id, phone: '08099999999' })).status === 404, 'a wrong phone number finds nothing');
const o2 = await must('POST', '/public/station/demo/orders', order, null, 201);
await must('POST', `/public/orders/${o2.token}/cancel`, {});
ok((await must('GET', `/public/orders/${o2.token}`)).status === 'cancelled', 'a customer can cancel a pending order');

const staffOrders = await must('GET', '/orders?status=pending', null, ada);
ok(staffOrders.some((x) => x.id === o.id && x.customer_name === 'Ngozi Test'), 'staff see the order with the customer details');
await must('POST', `/orders/${o.id}/status`, { status: 'confirmed' }, admin);
ok((await call('POST', `/public/orders/${o.token}/cancel`, {})).status === 400, 'a confirmed order cannot be cancelled online');
await must('POST', `/orders/${o.id}/status`, { status: 'completed' }, admin);
ok((await must('GET', '/catalog/products', null, admin)).find((p) => p.id === drum.id).stock_qty === 8, 'completing an order reduces stock (admin, no shift needed)');

// ---- expenses, reports, exports ----
const st = await must('POST', '/shifts/start', { pumps: [] }, ada, 201);
await must('POST', '/sales', { product_id: water.id, qty: 10, payment: 'cash' }, ada, 201);
await must('POST', '/expenses', { category: 'Generator fuel', amount: 5000, from_till: true }, ada, 201);
await must('POST', `/shifts/${st.id}/close`, { pumps: [], cash: 0 }, ada);
ok((await must('GET', `/shifts/${st.id}`, null, ada)).expected_amount === -2000, 'till expense reduces the expected cash');
const dash = await must('GET', '/reports/dashboard', null, admin);
ok(dash.today_sales > 0 && dash.tanks.length === 3 && dash.trend.length > 0, "dashboard shows today's sales, tanks and a trend");
const month = (await must('GET', '/reports/months', null, admin))[0];
ok((await must('GET', `/reports/monthly/${month}`, null, admin)).totals.revenue > 0, 'monthly recap is built');
for (const ext of ['pdf', 'xlsx']) {
  const r = await fetch(`${BASE}/reports/monthly/${month}/${ext}`, { headers: { Authorization: `Bearer ${admin}` } });
  ok(r.status === 200 && (await r.arrayBuffer()).byteLength > 1000, `recap downloads as ${ext}`);
}
ok((await (await fetch(`${BASE}/exports/sales`, { headers: { Authorization: `Bearer ${admin}` } })).text()).includes('product_name'), 'sales export works');
const audit = await must('GET', '/audit', null, admin);
ok(audit.some((a) => a.action === 'price_change') && audit.some((a) => a.action === 'shift_close') && audit.some((a) => a.action === 'order_status'), 'audit trail records price changes, shift closes and orders');
ok((await call('GET', '/credit/customers', null, admin)).status === 404 && (await call('GET', '/suppliers', null, admin)).status === 404, 'credit and supplier features are gone');

// ---- help guides per role, editable by the admin ----
const staffHelp = await must('GET', '/help', null, ada);
const adminHelp = await must('GET', '/help', null, admin);
ok(staffHelp.length > 3 && staffHelp.every((h) => h.audience === 'staff'), 'staff see only staff guides');
ok(adminHelp.length > 3 && adminHelp.every((h) => h.audience === 'admin'), 'admins see only admin guides');
const custHelp = await must('GET', '/public/station/demo/help');
ok(custHelp.length > 2 && custHelp.every((h) => h.audience === 'customer'), 'customers see only customer guides');
ok((await call('GET', '/help/manage', null, ada)).status === 403, 'staff cannot manage guides');
const newGuide = await must('POST', '/help/manage', { audience: 'customer', title: 'Opening hours', body: 'We open at 7am.' }, admin, 201);
ok((await must('GET', '/public/station/demo/help')).some((h) => h.id === newGuide.id), 'an admin can add a guide');
await must('DELETE', `/help/manage/${custHelp[0].id}`, null, admin);
ok(!(await must('GET', '/public/station/demo/help')).some((h) => h.id === custHelp[0].id), 'an admin can delete a guide');
const restored = await must('POST', '/help/manage/restore-defaults', {}, admin);
ok(restored.restored === 1, 'restore defaults brings back the deleted guide');

// ---- sign-up, approval, pause ----
const code = `test-${Date.now().toString(36)}`;
ok((await must('GET', `/auth/slug-available?slug=${code}`)).available, 'a new station code is available');
const signup = await must('POST', '/auth/signup', { business_name: 'Test Fuels', station_code: code, owner_name: 'Test Owner', email: `${code}@example.com`, phone: '08000000009', password: 'Password123' }, null, 201);
ok(signup.ok, 'a business owner can sign up');
ok(!(await must('GET', `/auth/slug-available?slug=${code}`)).available, 'that station code is now taken');
const pendingLogin = await call('POST', '/auth/login', { email: `${code}@example.com`, password: 'Password123' });
ok(pendingLogin.status === 403 && /approval/.test(pendingLogin.data.error), 'a new station cannot log in until approved');
ok((await call('GET', `/public/station/${code}/catalog`)).data.station.paused === true, 'a station waiting for approval has no open store');
const owner = (await must('POST', '/auth/platform-login', { username: 'owner', password: process.env.OWNER_PASSWORD || 'ChangeMe123!' })).token;
const list = await must('GET', '/platform/stations', null, owner);
const newSt = list.find((x) => x.slug === code);
ok(newSt && newSt.pending && newSt.owner.includes('Test Owner'), 'the platform owner sees the station waiting for approval');
await must('POST', `/platform/stations/${newSt.id}/approve`, {}, owner);
const ownerLogin = await must('POST', '/auth/login', { email: `${code}@example.com`, password: 'Password123' });
ok(ownerLogin.station.slug === code, 'the owner can log in after approval');
ok((await must('GET', '/catalog/products', null, ownerLogin.token)).length === 0, 'a new station starts with its own empty catalog');
ok((await must('GET', '/help/manage', null, ownerLogin.token)).length > 10, 'a new station gets its own copy of the guides');
await must('POST', `/platform/stations/${newSt.id}/pause`, {}, owner);
ok((await call('GET', '/catalog/products', null, ownerLogin.token)).status === 403, 'a paused station is locked out immediately');
ok((await call('POST', '/auth/login', { email: `${code}@example.com`, password: 'Password123' })).status === 403, 'a paused station cannot log in');
await must('POST', `/platform/stations/${newSt.id}/resume`, {}, owner);
ok((await call('GET', '/catalog/products', null, ownerLogin.token)).status === 200, 'a resumed station works again');
const created = await must('POST', '/platform/stations', { name: 'Second Station', slug: `second-${code}`.slice(0, 30), template: 'fuel_lube', admin_name: 'Second Admin', admin_username: 'admin2', admin_email: `second-${code}@example.com`, admin_password: 'Admin12345' }, owner, 201);
ok(created.station.active && !created.station.pending, 'the platform owner can add a station directly');

// ---- permissions ----
ok((await call('GET', '/reports/dashboard', null, ada)).status === 403, 'staff cannot open admin reports');
await must('PATCH', '/station', { ordering_enabled: false }, admin);
ok((await call('POST', '/public/station/demo/orders', order)).status === 400, 'orders are refused when the station turns ordering off');
await must('PATCH', '/station', { ordering_enabled: true }, admin);

console.log(`\nAll ${passed} checks passed.`);
