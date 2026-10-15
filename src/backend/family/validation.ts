
import {ApiError,object,text} from '../expenses/validation';
import {CARD_TYPES,type CardType} from '../../shared/apiTypes';
export type ReferenceKind = 'cards' | 'family_members';
export interface ReferenceChanges {name?:string;active?:boolean;phoneNumber?:string|null;cardType?:CardType|null}
export function validateReference(value:unknown,kind:ReferenceKind,creating:boolean):ReferenceChanges {
 const body=object(value);
 const allowed=kind==='cards'?['name','active','cardType']:['name','active','phoneNumber'];
 if(!Object.keys(body).length||Object.keys(body).some(k=>!allowed.includes(k)))throw new ApiError(400,'Campos de '+(kind==='cards'?'tarjeta':'integrante')+' inválidos.');
 const input:ReferenceChanges={};
 if(creating||Object.hasOwn(body,'name'))input.name=text(body.name,'name',120);
 if(Object.hasOwn(body,'active')){
  if(typeof body.active!=='boolean')throw new ApiError(400,'active debe ser booleano.');
  input.active=body.active;
 }else if(creating)input.active=true;
 if(kind==='family_members'){
  if(Object.hasOwn(body,'phoneNumber')){
   if(body.phoneNumber===null||body.phoneNumber==='')input.phoneNumber=null;
   else input.phoneNumber=text(body.phoneNumber,'phoneNumber',40);
  }else if(creating)input.phoneNumber=null;
 }else{
  if(Object.hasOwn(body,'cardType')){
   if(body.cardType===null)input.cardType=null;
   else if((CARD_TYPES as readonly unknown[]).includes(body.cardType))input.cardType=body.cardType as CardType;
   else throw new ApiError(400,'cardType debe ser credit_card, debit_card o null.');
  }else if(creating)input.cardType=null;
 }
 return input;
}
