// Administración de cuentas: quien tiene acceso a la base habilita, retira o desactiva el acceso web de un integrante.
// Uso: npm run db:member-account -- list | link <memberId> <authUserId> | unlink <memberId> | activate <memberId> | deactivate <memberId>
//      | set-role <memberId> admin|member  (el primer administrador se designa así: id explícito y cuenta ya vinculada)
// authUserId es el UUID del usuario en Supabase → Authentication → Users (se crea ahí con "Invite user").
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createDatabasePool } from '../src/backend/db/pool';
import { resolveFamilyId } from '../src/backend/expenses/service';
import { uuid } from '../src/backend/shared/validators';
import { setRole } from '../src/backend/accounts/roles';
export async function memberAccount(pool: Pool, command: string, memberId?: string, authUserId?: string): Promise<string> {
  const family = await resolveFamilyId(pool);
  if (command === 'list') {
    const rows = (await pool.query('SELECT id,name,role,active,auth_user_id IS NOT NULL AS linked,phone_number IS NOT NULL AS phone FROM appgastos.family_members WHERE family_id=$1 ORDER BY name',[family])).rows;
    return rows.map(r => `${r.id}  ${r.name}  ${r.role}  ${r.active ? 'activo' : 'inactivo'}  cuenta:${r.linked ? 'sí' : 'no'}  whatsapp:${r.phone ? 'sí' : 'no'}`).join('\n') || 'Sin integrantes.';
  }
  const id = uuid(memberId, 'memberId');
  if (command === 'set-role') {
    try { const r = await setRole(pool, family, id, authUserId, null); return 'Hecho: ' + r.name + ' ahora es ' + r.role; }
    catch (error: any) {
      // Error frecuente: se pasó el id del integrante pero todavía no se vinculó su cuenta de Supabase.
      if (error?.status === 409 && /cuenta/.test(error.message)) throw new Error(error.message + ' Vinculala primero: npm run db:member-account -- link ' + id + ' <User-UID-de-Supabase>');
      throw error;
    }
  }
  const sql: Record<string, [string, unknown[]]> = {
    link: ['UPDATE appgastos.family_members SET auth_user_id=$3 WHERE family_id=$1 AND id=$2 AND auth_user_id IS NULL', [family, id, command === 'link' ? uuid(authUserId, 'authUserId').toLowerCase() : null]],
    unlink: ['UPDATE appgastos.family_members SET auth_user_id=NULL WHERE family_id=$1 AND id=$2', [family, id]],
    activate: ['UPDATE appgastos.family_members SET active=true WHERE family_id=$1 AND id=$2', [family, id]],
    deactivate: ['UPDATE appgastos.family_members SET active=false WHERE family_id=$1 AND id=$2', [family, id]],
  };
  if (!sql[command]) throw new Error('Comando desconocido: ' + command);
  try {
    const result = await pool.query(...sql[command]);
    if (!result.rowCount) throw new Error(command === 'link' ? 'El integrante no existe o ya tiene una cuenta vinculada.' : 'El integrante no existe.');
  } catch (error: any) {
    if (error?.code === '23505') throw new Error('Esa cuenta ya está vinculada a otro integrante, o el número del integrante ya lo usa otro activo.');
    if (error?.code === '23503') throw new Error('La cuenta no existe en Supabase Auth.');
    throw error;
  }
  return 'Hecho: ' + command + ' ' + id;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.DATABASE_URL) throw new Error('Configura DATABASE_URL.');
  const pool = createDatabasePool(process.env.DATABASE_URL);
  try { console.log(await memberAccount(pool, process.argv[2] || 'list', process.argv[3], process.argv[4])); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Falló la operación.'); process.exitCode = 1; }
  finally { await pool.end(); }
}
