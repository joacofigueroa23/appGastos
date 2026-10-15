
import type {Pool} from 'pg';
import {ApiError,uuid} from '../expenses/validation';
import {validateReference,type ReferenceKind} from './validation';
import {insertReference,listReferences,updateReference} from './repository';
export function referenceService(pool:Pool,family:string,kind:ReferenceKind){
 return {
  list:()=>listReferences(pool,family,kind),
  create:(body:unknown)=>insertReference(pool,family,kind,validateReference(body,kind,true)),
  async update(id:string,body:unknown){
   const input=validateReference(body,kind,false);
   const result=await updateReference(pool,family,kind,uuid(id),input);
   if(!result)throw new ApiError(404,kind==='cards'?'Tarjeta inexistente.':'Integrante inexistente.');
   return result;
  }
 };
}
