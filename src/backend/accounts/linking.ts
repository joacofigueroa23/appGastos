import {createHash,randomInt} from 'node:crypto';
import type {Connection} from '../expenses/repository';
import {normalizePhone} from '../whatsapp/security';
import {failConversations} from '../whatsapp/conversation';
import {REPLIES} from '../whatsapp/replies';
export const LINK_TTL_MINUTES=10,MAX_LINK_FAILURES=5;
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',CODE_LENGTH=8;
const hash=(code:string)=>createHash('sha256').update(code).digest('hex');
const clean=(raw:string)=>raw.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
// "VINCULAR ABCD-2345" → "ABCD2345". Cualquier otro texto no es un comando de vinculación.
export function parseLinkCommand(text:string|null):string|null{
 const m=/^\s*vincular\s+([A-Za-z0-9 -]{6,24})\s*$/i.exec(text??'');
 return m?clean(m[1]):null;
}
const display=(code:string)=>code.slice(0,4)+'-'+code.slice(4);
// Genera un código de un solo uso para el integrante; reemplaza el anterior sin usar.
export async function createLinkCode(db:Connection,familyId:string,memberId:string){
 let code='';for(let i=0;i<CODE_LENGTH;i++)code+=ALPHABET[randomInt(ALPHABET.length)];
 const expiresAt=new Date(Date.now()+LINK_TTL_MINUTES*60000);
 await db.query('DELETE FROM appgastos.whatsapp_link_codes WHERE member_id=$1 AND used_at IS NULL',[memberId]);
 await db.query('INSERT INTO appgastos.whatsapp_link_codes(family_id,member_id,code_hash,expires_at) VALUES($1,$2,$3,$4)',[familyId,memberId,hash(code),expiresAt]);
 return {code:display(code),expiresAt:expiresAt.toISOString()};
}
export async function openLinkCode(db:Connection,memberId:string){
 const r=await db.query('SELECT expires_at FROM appgastos.whatsapp_link_codes WHERE member_id=$1 AND used_at IS NULL AND expires_at>now()',[memberId]);
 return r.rows[0]?{expiresAt:(r.rows[0].expires_at as Date).toISOString()}:null;
}
// Quita el número del integrante. Cierra su conversación pendiente: el número deja de poder responderla.
export async function unlinkPhone(db:Connection,familyId:string,memberId:string){
 await db.query('UPDATE appgastos.family_members SET phone_number=NULL WHERE family_id=$1 AND id=$2',[familyId,memberId]);
 await db.query('DELETE FROM appgastos.whatsapp_link_codes WHERE member_id=$1 AND used_at IS NULL',[memberId]);
 await failConversations(db,familyId,[memberId]);
}
// Se ejecuta dentro de la transacción que completa el mensaje: la vinculación y su respuesta son atómicas.
// Los mensajes de error no distinguen código inexistente, vencido o usado.
export async function attemptLink(db:Connection,familyId:string,sender:string,code:string):Promise<{outcome:'linked'|'link_failed';reply:string}>{
 const fail=(reply:string)=>({outcome:'link_failed' as const,reply});
 const recent=await db.query("SELECT count(*)::int AS n FROM appgastos.whatsapp_messages WHERE family_id=$1 AND sender=$2 AND outcome='link_failed' AND completed_at>now()-interval '1 hour'",[familyId,sender]);
 if(recent.rows[0].n>=MAX_LINK_FAILURES)return fail(REPLIES.linkLocked);
 const members=(await db.query('SELECT id,active,phone_number,auth_user_id FROM appgastos.family_members WHERE family_id=$1 FOR UPDATE',[familyId])).rows;
 if(members.some(m=>m.active&&normalizePhone(m.phone_number)===sender))return fail(REPLIES.linkAlready);
 const found=(await db.query('SELECT id,member_id FROM appgastos.whatsapp_link_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',[hash(clean(code))])).rows[0];
 const member=found&&members.find(m=>m.id===found.member_id);
 if(!member||!member.active||!member.auth_user_id||normalizePhone(member.phone_number))return fail(REPLIES.linkInvalid);
 await db.query('UPDATE appgastos.family_members SET phone_number=$3 WHERE family_id=$1 AND id=$2',[familyId,member.id,sender]);
 await db.query('UPDATE appgastos.whatsapp_link_codes SET used_at=now() WHERE id=$1',[found.id]);
 return {outcome:'linked',reply:REPLIES.linked};
}
