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
import {answerQuery,parseQuery} from './queries';
import {referenceDate} from './candidate';
import {documentCommand,documentProcessor,expireDocuments,type DocumentDeps} from '../documents/service';
import {parseCommand} from '../documents/commands';
import {geminiTurnInterpreter,type TurnInterpreter} from '../documents/turn';
import {focusedReply,hasOpenReceipt,parseRecovery} from '../documents/focus';
import {adminCommand} from './admin';
import {adminFlow} from './adminFlow';
import {geminiAdminInterpreter,isConfigWrite,type AdminInterpreter} from './adminIntent';
export function whatsappProcessor(pool:Pool,interpret:Interpreter,send:ReplySender,documents?:DocumentDeps,adminInterpret?:AdminInterpreter,turnInterpret?:TurnInterpreter){
 let adminInterpreter=adminInterpret,turnInterpreter=turnInterpret;
 const documentWorker=documents?documentProcessor(pool,documents):null;
 async function processNext(){
  const row=await claim(pool);if(!row)return false;
  try{
   // Hora real del mensaje: Meta si está, si no la recepción. Define fecha de referencia y vencimiento.
   const at=row.meta_timestamp??row.received_at;
   let focused:string|null=null,decision:Decision,catalog:Catalog|undefined,conversation:Conversation|null=null;
   if(row.message_type==='image'||row.message_type==='document'){
    // Comprobante: se identifica al remitente igual que con un texto. El archivo se lee después; acá solo se acepta o se rechaza.
    const members=(await memberPhones(pool,row.family_id)) as Member[];
    const matches=members.filter(m=>m.active&&normalizePhone(m.phone_number)===row.sender);
    if(matches.length!==1)decision={kind:'reply',outcome:'unauthorized',reply:REPLIES.unauthorized,failMembers:members.filter(m=>normalizePhone(m.phone_number)===row.sender).map(m=>m.id)};
    else if(!row.media)decision={kind:'reply',outcome:'unsupported',reply:REPLIES.unsupported};
    else decision={kind:'document',memberId:matches[0].id,media:row.media};
   }
   else if(row.message_type!=='text')decision={kind:'reply',outcome:'unsupported',reply:REPLIES.unsupported};
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
     // Consulta financiera ("¿cuánto gasté?"): se responde por reglas y SQL con los permisos del rol; no pasa por Gemini y
     // no toca la conversación pendiente.
     const query=parseQuery(row.text_body);
     // Confirmar, cancelar o corregir un comprobante abierto. Su efecto es idempotente (confirmar dos veces no registra dos veces),
     // así que reprocesar este mensaje tras un corte no duplica nada.
     const role=matches[0].role==='admin'?'admin' as const:'member' as const;
     // Acción de administración pendiente (confirmar, cancelar o completar un dato). Solo se abre una transacción si hay algo pendiente o
     // se confirma por código; su efecto es idempotente (confirmar dos veces no aplica dos veces), así que reprocesar tras un corte no duplica.
     const cmd=query?null:parseCommand(row.text_body!);
     const adminPending=!query&&(cmd?.type==='confirm'&&!!cmd.code||(await pool.query("SELECT 1 FROM appgastos.admin_actions WHERE family_id=$1 AND member_id=$2 AND state='pending'",[row.family_id,matches[0].id])).rowCount!>0);
     const adminReply=adminPending?await transaction(pool,db=>adminCommand(pool,db,{id:matches[0].id,role},row.family_id,row.text_body!,!!conversation,at,catalog!.familyCurrency)):null;
     // Una respuesta corta sin comando («ayer», «Combustible», «20 mil») también puede ser para un comprobante abierto que está esperando un dato.
     const mayBeAnswer=!query&&!adminReply&&parseCommand(row.text_body!)===null&&!conversation&&row.text_body!.trim().split(/\s+/).length<=4
      &&(await pool.query("SELECT 1 FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state='needs_review' AND kind IN ('purchase_receipt','payment_receipt') AND draft IS NOT NULL LIMIT 1",[row.family_id,matches[0].id])).rowCount!>0;
     const docReply=!query&&!adminReply&&(parseCommand(row.text_body!)!==null||mayBeAnswer)
      ?await transaction(pool,db=>documentCommand(pool,db,{id:matches[0].id,role:matches[0].role==='admin'?'admin':'member'},row.family_id,row.text_body!,!!conversation)):null;
     // Árbitro de contexto: recuperación («cancelá todo», «¿qué tengo pendiente?») y mensajes con varios datos para el comprobante abierto
     // («Supermercado confirmar»). Va antes de interpretar un gasto nuevo para que un dato suelto no abra otro gasto.
     const focusReply=!query&&!adminReply&&!docReply&&(parseRecovery(row.text_body!)!==null||await hasOpenReceipt(pool,row.family_id,matches[0].id))
      ?await transaction(pool,db=>focusedReply(pool,db,{id:matches[0].id,role:matches[0].role==='admin'?'admin':'member'},row.family_id,row.text_body!,!!conversation,turnInterpreter??(process.env.GEMINI_API_KEY?(turnInterpreter=geminiTurnInterpreter()):null))):null;
     if(adminReply)decision={kind:'reply',outcome:adminReply.outcome,reply:adminReply.reply};
     else if(docReply)decision={kind:'reply',outcome:docReply.outcome,reply:docReply.reply};
     else if(focusReply){focused=matches[0].id;decision={kind:'reply',outcome:focusReply.outcome,reply:focusReply.reply};}
     else if(query){const a=await answerQuery(pool,row.family_id,{role:matches[0].role==='admin'?'admin':'member',memberId:matches[0].id},query,at,catalog.familyCurrency);decision={kind:'reply',outcome:a.outcome,reply:a.reply};}
     else{
      // Configuración por WhatsApp: solo administradores. Gemini interpreta la frase; el backend valida, pregunta lo que falte y pide confirmación.
      const admin=role==='admin'?await adminFlow(pool,()=>adminInterpreter??(process.env.GEMINI_API_KEY?(adminInterpreter=geminiAdminInterpreter()):null),{family:row.family_id,memberId:matches[0].id,text:row.text_body!,at,familyCurrency:catalog.familyCurrency,hasConversation:!!conversation}):null;
      if(admin)decision={kind:'reply',outcome:admin.outcome,reply:admin.reply};
      else if(role==='member'&&isConfigWrite(row.text_body))decision={kind:'reply',outcome:'admin_denied',reply:'Esa operación es solo para administradores.'};
      else decision=await decide(pool,interpret,row,at,catalog,conversation);
     }
    }
   }
   // Si el árbitro cerró el gasto en curso, el commit trabaja con el estado vigente (si no, daría ConversationChanged y reintentaría).
   if(focused)conversation=await findActiveConversation(pool,row.family_id,focused);
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
  void drainDocuments();
 }
 // Leer un comprobante (descarga + modelo) puede tardar hasta un minuto: va en su propio ciclo para no demorar los mensajes de texto.
 let reading=false;
 async function drainDocuments(){
  if(reading||stopped||!documentWorker)return;reading=true;
  try{await expireDocuments(pool);for(let n=0;n<5&&!stopped;n++)if(!await documentWorker.processNext())break;}
  catch{console.warn('documents: worker_unavailable');}
  finally{reading=false;}
 }
 return {processNext,replyNext,processDocument:async()=>documentWorker?documentWorker.processNext():false,drain,drainDocuments,start(){const timer=setInterval(()=>{void drain();void drainDocuments();},2000);timer.unref();void drain();return ()=>{stopped=true;clearInterval(timer);};}};
}
