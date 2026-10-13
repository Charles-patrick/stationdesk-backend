import { pool } from '../db.js';

// Record who did what. Pass a transaction client when inside tx() so the log rolls back with the change.
export async function audit(ctx, action, entity, entityId, before = null, after = null, note = null, client = pool) {
  const user = ctx?.user || ctx || {};
  try {
    await client.query(
      `INSERT INTO audit_logs (station_id, user_id, user_name, action, entity, entity_id, before, after, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ctx?.stationId ?? user.station_id ?? null,
        user.id ?? null,
        user.name ?? null,
        action,
        entity,
        entityId ?? null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        note,
      ],
    );
  } catch (err) {
    console.error('audit failed', err.message);
    if (client !== pool) throw err;
  }
}
