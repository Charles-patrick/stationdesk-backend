import cron from 'node-cron';
import { many, one, q } from '../db.js';
import { localParts, monthKey, isLastDayOfMonth } from '../utils/time.js';
import { notify } from '../utils/notify.js';
import { sendEmail } from './email.js';
import { getRecap, buildDailySummary, recapPdf } from './recap.js';
import { config } from '../config.js';

// Claim a job so it runs once, even if the server restarts or runs twice
async function claim(key) {
  const r = await q('INSERT INTO job_runs (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [key]);
  return r.rowCount > 0;
}

export async function runJobs(now = new Date()) {
  const stations = await many('SELECT * FROM stations WHERE active');
  for (const s of stations) {
    try {
      const tz = s.timezone;
      const lp = localParts(now, tz);
      const dayKey = `${lp.year}-${lp.month}-${lp.day}`;

      // 1. Shifts left open too long: alert the admin once
      const stale = await many(
        `SELECT sh.id, u.name FROM shifts sh JOIN users u ON u.id = sh.user_id
          WHERE sh.station_id = $1 AND sh.status = 'open' AND sh.alerted_at IS NULL AND sh.started_at < now() - ($2 || ' hours')::interval`,
        [s.id, String(s.shift_alert_hours)]);
      for (const sh of stale) {
        await q('UPDATE shifts SET alerted_at = now() WHERE id = $1', [sh.id]);
        await notify({
          stationId: s.id, role: 'admin', type: 'open_shift',
          title: `${sh.name}'s shift has been open for over ${s.shift_alert_hours} hours`,
          body: 'If they have gone home, close it from the admin screen.', link: `/admin/shifts/${sh.id}`,
        });
      }

      // 2. Daily summary to the owner
      if (s.summary_enabled && lp.hour === s.summary_hour && (await claim(`summary:${s.id}:${dayKey}`))) {
        const sum = await buildDailySummary(s);
        await notify({ stationId: s.id, role: 'admin', type: 'daily_summary', title: `Daily summary for ${s.name}`, body: sum.text, link: '/admin', email: false });
        const to = s.summary_email || (await one("SELECT email FROM users WHERE station_id = $1 AND role = 'admin' AND email IS NOT NULL LIMIT 1", [s.id]))?.email;
        if (to) await sendEmail({ to, subject: `${s.name}: today's summary`, text: sum.text });
      }

      // 3. Monthly recap on the last day of the month, late evening
      if (isLastDayOfMonth(tz, now) && lp.hour >= 23) {
        const month = monthKey(now, tz);
        if (await claim(`recap:${s.id}:${month}`)) {
          const data = await getRecap(s.id, month, { refresh: true });
          await notify({
            stationId: s.id, role: 'admin', type: 'monthly_recap', title: `${month} recap is ready`,
            body: `Sales ${Math.round(data.totals.revenue).toLocaleString('en-NG')}. Open Reports to see the full recap.`, link: '/admin/reports', email: false,
          });
          const to = s.summary_email || (await one("SELECT email FROM users WHERE station_id = $1 AND role = 'admin' AND email IS NOT NULL LIMIT 1", [s.id]))?.email;
          if (to) {
            await sendEmail({
              to, subject: `${s.name}: ${month} monthly recap`, text: `Your monthly recap for ${month} is attached.`,
              attachments: [{ filename: `recap-${month}.pdf`, content: await recapPdf(data) }],
            });
          }
        }
      }
    } catch (err) {
      console.error(`Job failed for station ${s.id}:`, err.message);
    }
  }
}

export function startScheduler() {
  if (!config.enableJobs) return;
  cron.schedule('*/10 * * * *', () => { runJobs().catch((e) => console.error('jobs', e)); });
  console.log('Background jobs scheduled (every 10 minutes).');
}
