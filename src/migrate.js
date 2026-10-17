import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { copyDefaultHelp } from './services/help.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  await pool.query(sql);
  // Stations created before guides were per-station get their own copy
  const { rows } = await pool.query('SELECT id FROM stations s WHERE NOT EXISTS (SELECT 1 FROM station_help h WHERE h.station_id = s.id)');
  for (const r of rows) await copyDefaultHelp(pool, r.id);
  console.log('Database schema is up to date.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
