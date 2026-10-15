import pg from 'pg';
import { readFileSync } from 'node:fs';
export function createDatabasePool(connectionString: string): pg.Pool {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL inválida. Revisa la configuración local.'); }
  if (!['postgres:','postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL debe usar PostgreSQL.');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  // Una query sslmode no puede sobreescribir la verificación de certificados.
  for (const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
  const ca = !local && process.env.DATABASE_CA_FILE ? readFileSync(process.env.DATABASE_CA_FILE, 'utf8') : undefined;
  const pool = new pg.Pool({
    connectionString: url.toString(), max: 1, connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000, ssl: local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  });
  pool.on('error', () => console.error('PostgreSQL: conexión inactiva interrumpida.'));
  return pool;
}
