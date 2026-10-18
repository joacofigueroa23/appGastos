import type {Pool} from 'pg';
import {transaction} from '../expenses/repository';
import {memberPhones} from '../family/repository';
import {InterpretationError} from './candidate';
import {findActiveConversation,type Conversation} from './conversation';
import {REPLIES} from './replies';
import {normalizePhone} from './security';
import {claim} from './repository';
import type {Interpreter} from './interpretation';
import type {ReplySender} from './transport';
import {MAX_INTERPRETATION_ATTEMPTS,decide,loadCatalog,type Catalog,type Decision,type Member} from './decision';
import {ConversationChanged,commit} from './commit';
import {parseLinkCommand} from '../accounts/linking';
export function whatsappProcessor(pool:Pool,interpret:Interpreter,send:ReplySender){
 async function processNext(){
  const row=await claim(pool);if(!row)return false;
  try{
   // Hora real del mensaje: Meta si está, si no la recepción. Define fecha de referencia y vencimiento.
   const at=row.meta_timestamp??row.received_at;
   let decision:Decision,catalog:Catalog|undefined,conversation:Conversation|null=null;
   if(row.message_type!=='text')decision={kind:'reply',outcome:'unsupported',reply:REPLIES.unsupported};
   else if(parseLinkCommand(row.text_body)!==null)decision={kind:'link',code:parseLinkCommand(row.text_body)!};
   else{
    const members=(await memberPhones(pool,row.family_id)) as Member[];
    const matches=members.filter(m=>m.active&&normalizePhone(m.phone_number)===row.sender);
    if(matches.length!==1){
     // Un número que dejó de estar autorizado no continúa conversaciones; no se llama a Gemini.
     const owners=members.filter(m=>normalizePhone(m.phone_number)===row.sender).map(m=>m.id);
     decision={kind:'reply',outcome:'unauthorized',reply:REPLIES.unauthorized,failMembers:owners};
    }else{
     catalog=await loadCatalog(pool,row.family_id,matches[0]);
     conversation=await findActiveConversation(pool,row.family_id,matches[0].id);
     // Vencida: no se completa; se marca expired en la transacción y el mensaje es una interacción nueva.
     if(conversation&&new Date(conversation.expiresAt)<=at)conversation=null;
     decision=await decide(pool,interpret,row,at,catalog,conversation);
    }
   }
   await transaction(pool,db=>commit(pool,db,row,at,decision,catalog,conversation));
  }catch(error){
   const changed=error instanceof ConversationChanged;
   const code=error instanceof InterpretationError?'interpretation_retry':changed?'conversation_changed':'processing_failed';
   // Sin tope un mensaje que siempre falla bloquearía a los siguientes del mismo remitente.
   if(code==='processing_failed'&&row.attempts>=MAX_INTERPRETATION_ATTEMPTS){
    await pool.query("UPDATE appgastos.whatsapp_messages SET state='completed',outcome='unsupported',last_error=$3,reply_text=$4,completed_at=now(),text_body=NULL,lease_token=NULL,lease_until=NULL WHERE message_id=$1 AND state='processing' AND lease_token=$2",[row.message_id,row.lease_token,code,REPLIES.failed]);
    console.warn('whatsapp: '+code+'_gave_up');return true;
   }
   await pool.query("UPDATE appgastos.whatsapp_messages SET state='pending',lease_token=NULL,lease_until=NULL,last_error=$3,next_attempt_at=now()+($4||' seconds')::interval WHERE message_id=$1 AND state='processing' AND lease_token=$2",[row.message_id,row.lease_token,code,changed?'0':'15']);
   console.warn('whatsapp: '+code);
  }
  return true;
 }
 async function replyNext(){
  const row=await claim(pool,true);if(!row)return false;
  try{
   await send(row.sender,row.reply_text);
   await pool.query("UPDATE appgastos.whatsapp_messages SET reply_state='sent',reply_lease_token=NULL,reply_lease_until=NULL,last_error=CASE WHEN last_error LIKE 'reply_failed%' THEN NULL ELSE last_error END WHERE message_id=$1 AND reply_lease_token=$2",[row.message_id,row.reply_lease_token]);
  }catch(error){
   const code=error instanceof Error&&/^meta_[a-z_]+$/.test(error.message)?'reply_failed:'+error.message:'reply_failed';
   await pool.query("UPDATE appgastos.whatsapp_messages SET reply_state=$3,reply_lease_token=NULL,reply_lease_until=NULL,last_error=$4,reply_next_attempt_at=now()+interval '30 seconds' WHERE message_id=$1 AND reply_lease_token=$2",[row.message_id,row.reply_lease_token,row.reply_attempts>=5?'failed':'pending',code]);
   console.warn('whatsapp: '+code);
  }
  return true;
 }
 let running=false,stopped=false;
 async function drain(){
  if(running||stopped)return;running=true;
  try{for(let n=0;n<20&&!stopped;n++){const processed=await processNext(),replied=await replyNext();if(!processed&&!replied)break;}}
  catch{console.warn('whatsapp: worker_unavailable');}
  finally{running=false;}
 }
 return {processNext,replyNext,drain,start(){const timer=setInterval(()=>void drain(),2000);timer.unref();void drain();return ()=>{stopped=true;clearInterval(timer);};}};
}
