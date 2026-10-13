import { pool, many } from '../db.js';
import { sendEmail } from '../services/email.js';
import { sendSms, sendWhatsapp } from '../services/messaging.js';
import { config } from '../config.js';

// Send an in-app notification (and email) to specific users, or to every active admin of a station.
export async function notify({ stationId, userIds, role, type, title, body, link, email = true, client = pool }) {
  let users = [];
  if (userIds?.length) {
    users = await many("SELECT id, name, email, phone FROM users WHERE id = ANY($1) AND status = 'active'", [userIds], client);
  } else if (role) {
    users = await many("SELECT id, name, email, phone FROM users WHERE station_id = $1 AND role = $2 AND status = 'active'", [stationId, role], client);
    if (role === 'admin') {
      const linked = await many(
        `SELECT u.id, u.name, u.email, u.phone FROM users u JOIN admin_station_links l ON l.user_id = u.id
         WHERE l.station_id = $1 AND u.status = 'active'`, [stationId], client);
      const seen = new Set(users.map((u) => u.id));
      for (const u of linked) if (!seen.has(u.id)) users.push(u);
    }
  }
  if (!users.length) return;
  let slug = null;
  if (stationId) slug = (await client.query('SELECT slug FROM stations WHERE id = $1', [stationId])).rows[0]?.slug;
  for (const u of users) {
    await client.query(
      'INSERT INTO notifications (station_id, user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)',
      [stationId, u.id, type, title, body || null, link || null],
    );
    if (email && u.email) {
      const url = link && slug ? `${config.frontendUrl}/s/${slug}${link}` : config.frontendUrl;
      // Not awaited, so a slow mail server never blocks a request
      sendEmail({ to: u.email, subject: title, text: `${body || ''}\n\n${url}`.trim() });
    }
    if (u.phone) {
      sendSms({ to: u.phone, text: `${title}. ${body || ''}`.trim() });
      sendWhatsapp({ to: u.phone, text: `${title}. ${body || ''}`.trim() });
    }
  }
}
