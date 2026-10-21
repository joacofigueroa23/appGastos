import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {transaction} from '../expenses/repository';
// metaTimestamp: hora del mensaje según Meta; ordena los mensajes de cada remitente.
// media: datos del archivo que declara Meta (no el archivo). Solo para imagen y documento.
export interface MessageMedia {id:string;mime:string;sha256:string|null;filename:string|null;caption:string|null}
export interface IncomingMessage {id:string;sender:string;text:string|null;type:string;receivedAt:Date;metaTimestamp?:Date|null;media?:MessageMedia|null}
export interface InboxRow {message_id:string;family_id:string;sender:string;text_body:string|null;message_type:string;received_at:Date;meta_timestamp:Date|null;media:MessageMedia|null;lease_token:string;attempts:number;reply_text:string;reply_lease_token:string;reply_attempts:number}
export async function enqueue(pool:Pool,family:string,messages:IncomingMessage[]){
 await transaction(pool,async db=>{
  for(const m of messages)await db.query(
   'INSERT INTO appgastos.whatsapp_messages(message_id,family_id,sender,text_body,message_type,received_at,meta_timestamp,media) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(message_id) DO NOTHING',
   [m.id,family,m.sender,m.text,m.type,m.receivedAt,m.metaTimestamp??null,m.media?JSON.stringify(m.media):null]);
 });
}
// Orden real de un mensaje: hora de Meta si existe; desempata la recepción y el id.
const ORDER="(COALESCE(%.meta_timestamp,%.received_at),%.received_at,%.message_id)";
const order=(alias:string)=>ORDER.replace(/%/g,alias);
export async function claim(pool:Pool,reply=false):Promise<InboxRow|null>{
 const token=randomUUID();
 const sql=reply?
  "WITH picked AS (SELECT message_id FROM appgastos.whatsapp_messages WHERE state='completed' AND reply_text IS NOT NULL AND reply_next_attempt_at<=now() AND (reply_state='pending' OR (reply_state='sending' AND reply_lease_until<now())) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE appgastos.whatsapp_messages m SET reply_state='sending',reply_lease_token=$1,reply_lease_until=now()+interval '30 seconds',reply_attempts=reply_attempts+1 FROM picked WHERE m.message_id=picked.message_id RETURNING m.*":
  // En serie por remitente: no se toma un mensaje si hay otro anterior del mismo remitente sin completar.
  "WITH picked AS (SELECT w.message_id FROM appgastos.whatsapp_messages w WHERE w.next_attempt_at<=now() AND (w.state='pending' OR (w.state='processing' AND w.lease_until<now()))"+
  " AND NOT EXISTS (SELECT 1 FROM appgastos.whatsapp_messages o WHERE o.family_id=w.family_id AND o.sender=w.sender AND o.state<>'completed' AND "+order('o')+"<"+order('w')+")"+
  " ORDER BY "+order('w')+" FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE appgastos.whatsapp_messages m SET state='processing',lease_token=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1 FROM picked WHERE m.message_id=picked.message_id RETURNING m.*";
 return (await pool.query(sql,[token])).rows[0]||null;
}
