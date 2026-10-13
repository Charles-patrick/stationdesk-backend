import { audit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { bad, notFound, forbidden } from '../utils/http.js';
import { moveTank, round2 } from '../utils/stock.js';
import { priceAt } from '../utils/pricing.js';

// Price changes that happened during a shift and still need a pump reading from the attendant.
export async function pendingReadings(client, shiftId) {
  const { rows } = await client.query(
    `SELECT sp.id AS shift_pump_id, pu.name AS pump_name, ph.id AS price_history_id, ph.old_price, ph.price AS new_price,
            ph.effective_at, pr.name AS product_name
       FROM shift_pumps sp
       JOIN shifts s ON s.id = sp.shift_id
       JOIN pumps pu ON pu.id = sp.pump_id
       JOIN products pr ON pr.id = pu.product_id
       JOIN price_history ph ON ph.product_id = pu.product_id AND ph.kind = 'change'
            AND ph.effective_at > s.started_at AND ph.effective_at <= now()
  LEFT JOIN pump_price_readings r ON r.shift_pump_id = sp.id AND r.price_history_id = ph.id
      WHERE sp.shift_id = $1 AND r.id IS NULL
      ORDER BY ph.effective_at`,
    [shiftId],
  );
  return rows;
}

export async function startShift(client, ctx, pumpsInput) {
  const user = ctx.user;
  const open = await client.query("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [user.id]);
  if (open.rows[0]) throw bad('You already have an open shift. Close it before starting a new one.');
  const { rows: [shift] } = await client.query(
    'INSERT INTO shifts (station_id, user_id) VALUES ($1,$2) RETURNING *', [ctx.stationId, user.id]);
  const flags = [];
  for (const input of pumpsInput) {
    const { rows: [pump] } = await client.query(
      'SELECT * FROM pumps WHERE id = $1 AND station_id = $2 AND active FOR UPDATE', [input.pump_id, ctx.stationId]);
    if (!pump) throw bad('Pump not found');
    const taken = await client.query(
      `SELECT u.name FROM shift_pumps sp JOIN shifts s ON s.id = sp.shift_id JOIN users u ON u.id = s.user_id
        WHERE sp.pump_id = $1 AND s.status = 'open' AND s.id <> $2`, [pump.id, shift.id]);
    if (taken.rows[0]) throw bad(`${pump.name} is already on ${taken.rows[0].name}'s shift`);
    const expected = Number(pump.current_reading);
    const opening = input.opening_reading === undefined || input.opening_reading === null ? expected : Number(input.opening_reading);
    if (!Number.isFinite(opening) || opening < 0) throw bad(`Enter a valid opening reading for ${pump.name}`);
    const gap = round2(opening - expected);
    await client.query(
      `INSERT INTO shift_pumps (shift_id, pump_id, expected_opening, opening_reading, gap_litres) VALUES ($1,$2,$3,$4,$5)`,
      [shift.id, pump.id, expected, opening, gap]);
    await client.query('UPDATE pumps SET current_reading = $1 WHERE id = $2', [opening, pump.id]);
    if (Math.abs(gap) > 0.005) {
      flags.push({ type: 'meter_gap', pump: pump.name, expected, actual: opening, litres: gap });
      if (gap > 0 && pump.tank_id) {
        await moveTank(client, { stationId: ctx.stationId, tankId: pump.tank_id, delta: -gap, type: 'meter_gap',
          refType: 'shift', refId: shift.id, note: `Unrecorded litres on ${pump.name} before this shift`, userId: user.id });
      }
    }
  }
  if (flags.length) {
    await client.query('UPDATE shifts SET flags = $1 WHERE id = $2', [JSON.stringify(flags), shift.id]);
    await notify({
      stationId: ctx.stationId, role: 'admin', type: 'variance', client,
      title: 'Opening reading does not match last close',
      body: flags.map((f) => `${f.pump}: expected ${f.expected}, ${user.name} entered ${f.actual}`).join('. '),
      link: `/admin/shifts/${shift.id}`,
    });
  }
  await audit(ctx, 'shift_start', 'shift', shift.id, null, { pumps: pumpsInput.map((p) => p.pump_id) }, null, client);
  return shift;
}

export async function recordPriceReadings(client, ctx, shift, readings) {
  for (const r of readings) {
    const { rows: [sp] } = await client.query(
      `SELECT sp.*, pu.product_id FROM shift_pumps sp JOIN pumps pu ON pu.id = sp.pump_id WHERE sp.id = $1 AND sp.shift_id = $2`,
      [r.shift_pump_id, shift.id]);
    if (!sp) throw bad('That pump is not on this shift');
    const { rows: [ph] } = await client.query(
      `SELECT * FROM price_history WHERE id = $1 AND product_id = $2 AND kind = 'change'`, [r.price_history_id, sp.product_id]);
    if (!ph) throw bad('That price change does not apply to this pump');
    const reading = Number(r.reading);
    if (!Number.isFinite(reading) || reading < 0) throw bad('Enter a valid pump reading');
    const { rows: [prev] } = await client.query(
      `SELECT COALESCE(MAX(r.reading), $2) AS last FROM pump_price_readings r
         JOIN price_history h ON h.id = r.price_history_id
        WHERE r.shift_pump_id = $1 AND h.effective_at < $3`, [sp.id, sp.opening_reading, ph.effective_at]);
    if (reading < Number(prev.last)) throw bad('This reading is lower than the one before it');
    await client.query(
      `INSERT INTO pump_price_readings (shift_pump_id, price_history_id, reading, recorded_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (shift_pump_id, price_history_id) DO UPDATE SET reading = EXCLUDED.reading, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [sp.id, ph.id, reading, ctx.user.id]);
  }
}

export async function closeShift(client, ctx, shiftId, body, { adminClose = false } = {}) {
  const { rows: [shift] } = await client.query('SELECT * FROM shifts WHERE id = $1 AND station_id = $2 FOR UPDATE', [shiftId, ctx.stationId]);
  if (!shift) throw notFound('Shift not found');
  if (shift.status !== 'open') throw bad('This shift is already closed');
  if (!adminClose && shift.user_id !== ctx.user.id) throw forbidden('Only the person on this shift can close it');
  if (adminClose && !body.note) throw bad('Add a note explaining why you are closing this shift');

  const { rows: [station] } = await client.query('SELECT * FROM stations WHERE id = $1', [ctx.stationId]);

  if (body.price_readings?.length) await recordPriceReadings(client, ctx, shift, body.price_readings);
  const pending = await pendingReadings(client, shift.id);
  if (pending.length) {
    throw bad(`Record the pump reading for the price change on ${pending.map((p) => p.pump_name).join(', ')} before closing`);
  }

  const { rows: sps } = await client.query(
    `SELECT sp.*, pu.name AS pump_name, pu.product_id, pu.tank_id, pu.meter_max, pr.name AS product_name
       FROM shift_pumps sp JOIN pumps pu ON pu.id = sp.pump_id JOIN products pr ON pr.id = pu.product_id
      WHERE sp.shift_id = $1`, [shift.id]);

  const inputs = new Map((body.pumps || []).map((p) => [Number(p.shift_pump_id), p]));
  const soldByTank = new Map();
  let pumpSalesTotal = 0;
  const flags = [...(shift.flags || [])];
  const now = new Date();

  for (const sp of sps) {
    const input = inputs.get(sp.id);
    if (!input || input.closing_reading === undefined || input.closing_reading === null || input.closing_reading === '') {
      throw bad(`Enter the closing reading for ${sp.pump_name}`);
    }
    const closing = Number(input.closing_reading);
    if (!Number.isFinite(closing) || closing < 0) throw bad(`Closing reading for ${sp.pump_name} is not valid`);

    const { rows: changes } = await client.query(
      `SELECT ph.price, r.reading FROM price_history ph
         JOIN pump_price_readings r ON r.price_history_id = ph.id AND r.shift_pump_id = $1
        ORDER BY ph.effective_at`, [sp.id]);
    const basePrice = await priceAt(client, sp.product_id, shift.started_at);
    const points = [Number(sp.opening_reading), ...changes.map((c) => Number(c.reading)), closing];
    const prices = [basePrice, ...changes.map((c) => Number(c.price))];

    let litresTotal = 0;
    let amountTotal = 0;
    for (let i = 0; i < prices.length; i++) {
      let diff = round2(points[i + 1] - points[i]);
      if (diff < 0) {
        const last = i === prices.length - 1;
        if (last && input.rollover) diff = round2(Number(sp.meter_max) - points[i] + points[i + 1]);
        else throw bad(`Closing reading for ${sp.pump_name} is lower than the earlier reading. If the meter went past its maximum and started again, tick "Meter rolled over".`);
      }
      if (diff === 0) continue;
      const amount = round2(diff * prices[i]);
      litresTotal += diff;
      amountTotal += amount;
      await client.query(
        `INSERT INTO sales (station_id, shift_id, product_id, product_name, pump_id, qty, unit_price, amount, source, payment, entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pump','cash',$9)`,
        [ctx.stationId, shift.id, sp.product_id, sp.product_name, sp.pump_id, diff, prices[i], amount, shift.user_id]);
    }
    litresTotal = round2(litresTotal);
    amountTotal = round2(amountTotal);
    pumpSalesTotal += amountTotal;
    await client.query(
      'UPDATE shift_pumps SET closing_reading = $1, rollover = $2, litres = $3, amount = $4 WHERE id = $5',
      [closing, !!input.rollover, litresTotal, amountTotal, sp.id]);
    await client.query('UPDATE pumps SET current_reading = $1 WHERE id = $2', [closing, sp.pump_id]);
    if (sp.tank_id && litresTotal > 0) {
      await moveTank(client, { stationId: ctx.stationId, tankId: sp.tank_id, delta: -litresTotal, type: 'pump_sale',
        refType: 'shift', refId: shift.id, note: `${sp.pump_name} sales`, userId: shift.user_id });
      soldByTank.set(sp.tank_id, round2((soldByTank.get(sp.tank_id) || 0) + litresTotal));
    }
  }

  // Dipstick readings: compare book stock with what is physically in each tank
  for (const dip of body.dips || []) {
    if (dip.litres === '' || dip.litres === undefined || dip.litres === null) continue;
    const { rows: [tank] } = await client.query('SELECT * FROM tanks WHERE id = $1 AND station_id = $2', [dip.tank_id, ctx.stationId]);
    if (!tank) throw bad('Tank not found');
    const litres = Number(dip.litres);
    if (!Number.isFinite(litres) || litres < 0) throw bad(`Dip reading for ${tank.name} is not valid`);
    const book = Number(tank.current_litres);
    const variance = round2(litres - book);
    const tolerance = Math.max(2, ((Number(station.litre_tolerance_pct) / 100) * (soldByTank.get(tank.id) || 0)));
    const flagged = Math.abs(variance) > tolerance;
    await client.query(
      `INSERT INTO dip_readings (station_id, tank_id, shift_id, litres, book_litres, variance, flagged, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.stationId, tank.id, shift.id, litres, book, variance, flagged, ctx.user.id]);
    if (flagged) flags.push({ type: 'dip', tank: tank.name, book, dip: litres, litres: variance });
  }

  const sums = await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE source = 'pump'), 0) AS pump_sales,
       COALESCE(SUM(amount) FILTER (WHERE source <> 'pump' AND payment <> 'credit'), 0) AS manual_sales,
       COALESCE(SUM(amount) FILTER (WHERE payment = 'credit'), 0) AS credit_sales
       FROM sales WHERE shift_id = $1 AND NOT voided`, [shift.id]);
  const { rows: [cp] } = await client.query(
    "SELECT COALESCE(SUM(amount),0) AS total FROM credit_entries WHERE shift_id = $1 AND type = 'payment' AND NOT voided", [shift.id]);
  const { rows: [ex] } = await client.query(
    'SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE shift_id = $1 AND from_till AND NOT voided', [shift.id]);

  const s = sums.rows[0];
  const expected = round2(Number(s.pump_sales) + Number(s.manual_sales) + Number(cp.total) - Number(ex.total));
  const cash = Number(body.cash || 0), transfer = Number(body.transfer || 0), pos = Number(body.pos || 0);
  const declared = round2(cash + transfer + pos);
  const variance = round2(declared - expected);
  const cashTolerance = Math.max(1, (Number(station.cash_tolerance_pct) / 100) * Math.abs(expected));
  if (Math.abs(variance) > cashTolerance) flags.push({ type: 'cash', expected, declared, amount: variance });

  await client.query(
    `UPDATE shifts SET status='closed', closed_at=$1, closed_by=$2, admin_closed=$3, close_note=$4,
       cash_declared=$5, transfer_declared=$6, pos_declared=$7, pump_sales=$8, manual_sales=$9, credit_sales=$10,
       credit_payments=$11, till_expenses=$12, expected_amount=$13, variance_amount=$14, flags=$15 WHERE id=$16`,
    [now, ctx.user.id, adminClose, body.note || null, cash, transfer, pos, Number(s.pump_sales), Number(s.manual_sales),
      Number(s.credit_sales), Number(cp.total), Number(ex.total), expected, variance, JSON.stringify(flags), shift.id]);

  await audit(ctx, adminClose ? 'shift_admin_close' : 'shift_close', 'shift', shift.id, null,
    { expected, declared, variance, flags: flags.length }, body.note || null, client);

  const serious = flags.filter((f) => f.type !== 'meter_gap' || true);
  if (serious.length) {
    const who = (await client.query('SELECT name FROM users WHERE id = $1', [shift.user_id])).rows[0]?.name;
    await notify({
      stationId: ctx.stationId, role: 'admin', type: 'variance', client,
      title: `Check ${who}'s shift: ${serious.length} flag${serious.length > 1 ? 's' : ''}`,
      body: serious.map((f) => (f.type === 'cash' ? `Cash difference ${f.amount}` : f.type === 'dip' ? `${f.tank} dip differs by ${f.litres} L` : `${f.pump} meter gap ${f.litres} L`)).join('. '),
      link: `/admin/shifts/${shift.id}`,
    });
  }
  return { id: shift.id, expected, declared, variance, flags };
}
