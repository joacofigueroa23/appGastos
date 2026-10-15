
import {createHmac,timingSafeEqual} from 'node:crypto';
export function validSignature(raw:Buffer,signature:unknown,secret:string):boolean{
 if(!secret||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))return false;
 return timingSafeEqual(createHmac('sha256',secret).update(raw).digest(),Buffer.from(signature.slice(7),'hex'));
}
export function normalizePhone(value:unknown):string|null{
 if(typeof value!=='string'||!/^\+?[\d\s()\-]+$/.test(value.trim()))return null;
 const n=value.replace(/[\s()+\-]/g,'');
 return /^\d{8,15}$/.test(n)?n:null;
}
