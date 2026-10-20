import type {Pool} from 'pg';
import {transaction} from '../expenses/repository';
import {ApiError} from '../shared/errors';
import {uuid} from '../shared/validators';
import type {Role} from './policy';
// Promueve o degrada. Lo usan el endpoint de administradores y el comando de línea (primer administrador).
// Los administradores se bloquean primero: dos cambios simultáneos se ejecutan uno detrás del otro.
export async function setRole(pool:Pool,family:string,targetId:string,role:unknown,byMemberId:string|null){
 if(role!=='admin'&&role!=='member')throw new ApiError(400,"role debe ser 'admin' o 'member'.");
 uuid(targetId);
 return transaction(pool,async db=>{
  await db.query("SELECT id FROM appgastos.family_members WHERE family_id=$1 AND role='admin' ORDER BY id FOR UPDATE",[family]);
  const target=(await db.query('SELECT id,name,role,active,auth_user_id FROM appgastos.family_members WHERE family_id=$1 AND id=$2 FOR UPDATE',[family,targetId])).rows[0];
  if(!target)throw new ApiError(404,'Integrante inexistente.');
  // Un administrador tiene que poder iniciar sesión: sin cuenta o inactivo no puede serlo.
  if(role==='admin'&&!target.active)throw new ApiError(409,'El integrante está inactivo.');
  if(role==='admin'&&!target.auth_user_id)throw new ApiError(409,'El integrante todavía no tiene cuenta para iniciar sesión.');
  if(target.role===role)return {id:target.id as string,name:target.name as string,role:role as Role};
  try{
   await db.query('UPDATE appgastos.family_members SET role=$3,role_changed_at=now(),role_changed_by_member_id=$4 WHERE family_id=$1 AND id=$2',[family,targetId,role,byMemberId]);
  }catch(error:any){
   if(error?.message==='last_admin')throw new ApiError(409,'No se puede dejar a la familia sin un administrador activo.');
   throw error;
  }
  return {id:target.id as string,name:target.name as string,role:role as Role};
 });
}
