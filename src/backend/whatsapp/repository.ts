
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {transaction} from '../expenses/repository';
export interface IncomingMessage {id:string;sender:string;text:string|null;type:string;receivedAt:Date}
export interface InboxRow {message_id:string;family_id:string;sender:string;text_body:string|null;message_type:string;received_at:Date;lease_token:string;attempts:number;reply_text:string;reply_lease_token:string;reply_attempts:number}
export async function enqueue(pool:Pool,family:string,messages:IncomingMessage[]){
 await transaction(pool,async db=>{
  for(const m of messages)await db.query(
   'INSERT INTO appgastos.whatsapp_messages(message_id,family_id,sender,text_body,message_type,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id) DO NOTHING',
   [m.id,family,m.sender,m.text,m.type,m.receivedAt]);
 });
}
export async function claim(pool:Pool,reply=false):Promise<InboxRow|null>{
 const token=randomUUID();
 const sql=reply?
  "WITH picked AS (SELECT message_id FROM appgastos.whatsapp_messages WHERE state='completed' AND reply_text IS NOT NULL AND reply_next_attempt_at<=now() AND (reply_state='pending' OR (reply_state='sending' AND reply_lease_until<now())) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE appgastos.whatsapp_messages m SET reply_state='sending',reply_lease_token=$1,reply_lease_until=now()+interval '30 seconds',reply_attempts=reply_attempts+1 FROM picked WHERE m.message_id=picked.message_id RETURNING m.*":
  "WITH picked AS (SELECT message_id FROM appgastos.whatsapp_messages WHERE next_attempt_at<=now() AND (state='pending' OR (state='processing' AND lease_until<now())) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE appgastos.whatsapp_messages m SET state='processing',lease_token=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1 FROM picked WHERE m.message_id=picked.message_id RETURNING m.*";
 return (await pool.query(sql,[token])).rows[0]||null;
}
