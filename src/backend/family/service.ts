
import type {Pool} from 'pg';
import {ApiError} from '../shared/errors';
import {uuid} from '../shared/validators';
import {normalizePhone} from '../whatsapp/security';
import {validateReference,type ReferenceKind} from './validation';
import {insertReference,listReferences,updateReference} from './repository';
export function referenceService(pool:Pool,family:string,kind:ReferenceKind,session=false){
 return {
  list:(only?:string)=>listReferences(pool,family,kind,only),
  create:(body:unknown)=>insertReference(pool,family,kind,validateReference(body,kind,true)),
  async update(id:string,body:unknown){
   const input=validateReference(body,kind,false);
   // Con sesión individual el WhatsApp de una cuenta solo cambia por la vinculación verificada (Mi perfil), ni siquiera por un
   // administrador. Activar o desactivar sí es del administrador; el último administrador activo lo protege la base.
   if(session&&kind==='family_members'&&'phoneNumber' in input){
    const row=(await pool.query('SELECT auth_user_id,phone_number FROM appgastos.family_members WHERE family_id=$1 AND id=$2',[family,uuid(id)])).rows[0];
    const phone=(value:unknown)=>typeof value==='string'?normalizePhone(value)??value.trim():null;
    if(row?.auth_user_id&&phone(input.phoneNumber)!==phone(row.phone_number))throw new ApiError(403,'El WhatsApp de una cuenta se vincula desde Mi perfil.');
   }
   const result=await updateReference(pool,family,kind,uuid(id),input);
   if(!result)throw new ApiError(404,kind==='cards'?'Tarjeta inexistente.':'Integrante inexistente.');
   return result;
  }
 };
}
