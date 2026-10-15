import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createDatabasePool } from '../src/backend/db/pool';
import { EXPENSE_CATEGORIES } from '../src/data/financeCatalog';
import { transaction } from '../src/backend/expenses/repository';
import { text, uuid } from '../src/backend/expenses/validation';
export const INITIAL_FAMILY_ID = '00000000-0000-4000-8000-000000000001';
export async function seed(pool: Pool, familyId = INITIAL_FAMILY_ID, memberName?: string): Promise<void> {
  uuid(familyId);
  await transaction(pool,async (db) => {
    await db.query('INSERT INTO appgastos.families(id,name,default_currency) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[familyId,process.env.SEED_FAMILY_NAME || 'Familia','ARS']);
    for (const name of EXPENSE_CATEGORIES) await db.query('INSERT INTO appgastos.categories(family_id,name) VALUES($1,$2) ON CONFLICT(family_id,name) DO NOTHING',[familyId,name]);
    if (memberName) await db.query('INSERT INTO appgastos.family_members(family_id,name) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM appgastos.family_members WHERE family_id=$1 AND name=$2)',[familyId,text(memberName,'memberName',120)]);
  });
  console.log('Seed inicial aplicado: familia y categorías. Sin gastos ni tarjetas.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.DATABASE_URL) throw new Error('Configura DATABASE_URL.');
  const pool=createDatabasePool(process.env.DATABASE_URL);
  try { await seed(pool,process.env.APP_FAMILY_ID || INITIAL_FAMILY_ID,process.env.SEED_MEMBER_NAME); }
  catch { console.error('Falló el seed inicial; revisa conexión y migraciones.'); process.exitCode=1; }
  finally { await pool.end(); }
}
