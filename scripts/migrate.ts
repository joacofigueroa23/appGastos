import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../src/backend/db/pool';
import type { Pool } from 'pg';
export async function migrate(pool: Pool): Promise<void> {
  const directory = fileURLToPath(new URL('../supabase/migrations/',import.meta.url));
  const db = await pool.connect();
  try {
    await db.query('SELECT pg_advisory_lock(88421017)');
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(directory + '/' + name,'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const exists = (await db.query("SELECT to_regclass('appgastos.schema_migrations') AS ledger")).rows[0].ledger;
      const applied = exists ? (await db.query('SELECT checksum FROM appgastos.schema_migrations WHERE name=$1',[name])).rows[0] : null;
      if (applied) { if (applied.checksum !== checksum) throw new Error('Migración aplicada modificada: '+name); continue; }
      try {
        await db.query('BEGIN'); await db.query(sql);
        await db.query('INSERT INTO appgastos.schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
        await db.query('COMMIT'); console.log('Migración aplicada: '+name);
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
  } finally { try { await db.query('SELECT pg_advisory_unlock(88421017)'); } finally { db.release(); } }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.DATABASE_URL) throw new Error('Configura DATABASE_URL.');
  const pool = createDatabasePool(process.env.DATABASE_URL);
  try { await migrate(pool); } catch { console.error('Falló la migración; revisa conexión y esquema.'); process.exitCode=1; }
  finally { await pool.end(); }
}
