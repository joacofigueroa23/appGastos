
import type {Pool} from 'pg';
import {ApiError} from '../shared/errors';
import {uuid} from '../shared/validators';
import {normalizePhone} from '../whatsapp/security';
import {validateReference,type ReferenceKind} from './validation';
import {insertReference,listReferences,updateReference} from './repository';
export function referenceService(pool:Pool,family:string,kind:ReferenceKind,session=false){
 return {
  list:()=>listReferences(pool,family,kind),
  create:(body:unknown)=>insertReference(pool,family,kind,validateReference(body,kind,true)),
  async update(id:string,body:unknown){
   const input=validateReference(body,kind,false);
   // Con sesión individual, el acceso web y el WhatsApp de una cuenta solo cambian por la vinculación del propio integrante
   // o por quien administra la base (scripts/member-account.ts), no por otro integrante.
   if(session&&kind==='family_members'&&('phoneNumber' in input||'active' in input)){
    const row=(await pool.query('SELECT auth_user_id,phone_number,active FROM appgastos.family_members WHERE family_id=$1 AND id=$2',[family,uuid(id)])).rows[0];
    if(row?.auth_user_id){
     const phone=(value:unknown)=>typeof value==='string'?normalizePhone(value)??value.trim():null;
     if('phoneNumber' in input&&phone(input.phoneNumber)!==phone(row.phone_number))throw new ApiError(403,'El WhatsApp de una cuenta se vincula desde Mi perfil.');
     if('active' in input&&input.active!==row.active)throw new ApiError(403,'Una cuenta con acceso la habilita o deshabilita quien administra la app.');
    }
   }
   const result=await updateReference(pool,family,kind,uuid(id),input);
   if(!result)throw new ApiError(404,kind==='cards'?'Tarjeta inexistente.':'Integrante inexistente.');
   return result;
  }
 };
}
