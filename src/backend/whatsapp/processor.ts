
import type {Pool} from 'pg';
import {expenseService} from '../expenses/service';
import {transaction} from '../expenses/repository';
import {ApiError} from '../expenses/validation';
import {InterpretationError,parseInterpretation,referenceDate,validateExpenseCandidate,type CardEntry,type CatalogEntry,type InterpretationContext} from './candidate';
import {normalizePhone} from './security';
import {claim} from './repository';
import type {Interpreter} from './interpretation';
import type {ReplySender} from './transport';
type Member=CatalogEntry&{phone_number:string|null};
const MAX_INTERPRETATION_ATTEMPTS=5;
export function whatsappProcessor(pool:Pool,interpret:Interpreter,send:ReplySender){
 async function processNext(){
  const row=await claim(pool);if(!row)return false;
  try{
   let reply='',outcome='interpretation_error',ctx:InterpretationContext|undefined;
   let validated:ReturnType<typeof validateExpenseCandidate>|undefined;
   if(row.message_type!=='text'){reply='Por ahora solo puedo recibir gastos por texto. No proceso imágenes, audio ni documentos.';outcome='unsupported';}
   else{
    const members=(await pool.query('SELECT id,name,active,phone_number FROM appgastos.family_members WHERE family_id=$1',[row.family_id])).rows as Member[];
    const matches=members.filter(m=>m.active&&normalizePhone(m.phone_number)===row.sender);
    if(matches.length!==1){reply='Este número no está autorizado para registrar gastos. Revisa su configuración con la familia.';outcome='unauthorized';}
    else{
     const family=(await pool.query('SELECT default_currency FROM appgastos.families WHERE id=$1',[row.family_id])).rows[0];
     const categories=(await pool.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1',[row.family_id])).rows as CatalogEntry[];
     const cards=(await pool.query('SELECT id,name,active,card_type AS "cardType" FROM appgastos.cards WHERE family_id=$1',[row.family_id])).rows as CardEntry[];
     ctx={text:row.text_body!,referenceDate:referenceDate(row.received_at),defaultCurrency:family.default_currency,categories,cards,member:matches[0]};
     try{validated=validateExpenseCandidate(parseInterpretation(await interpret(ctx)),ctx);}
     catch(error){
      const transient=error instanceof InterpretationError&&error.message==='transient';
      // Un fallo pasajero de Gemini vuelve el mensaje a la cola; agotados los intentos se informa.
      if(transient&&row.attempts<MAX_INTERPRETATION_ATTEMPTS)throw error;
      reply=transient?'El servicio de interpretación no está disponible ahora. No se registró ningún gasto; reenvía el mensaje en unos minutos.':
       'No pude interpretar el mensaje. No se registró ningún gasto; intenta con un texto completo o usa la carga manual.';
      outcome='interpretation_error';
     }
     if(validated){
      if(validated.valid){outcome='registered';}
      else{
       reply='No registré el gasto. Necesito revisar: '+[...validated.missingFields,...validated.validationErrors].join(', ')+'. Envía un nuevo mensaje completo; no continúo conversaciones todavía.';
       outcome='incomplete';
      }
     }
    }
   }
   // Expense and processed message commit together, under a durable lock.
   await transaction(pool,async db=>{
    const locked=(await db.query('SELECT state,lease_token FROM appgastos.whatsapp_messages WHERE message_id=$1 FOR UPDATE',[row.message_id])).rows[0];
    if(locked.state!=='processing'||locked.lease_token!==row.lease_token)return;
    let expenseId:string|null=null;
    if(validated?.valid&&validated.expense&&ctx){
     const member=(await db.query('SELECT active,phone_number FROM appgastos.family_members WHERE family_id=$1 AND id=$2 FOR SHARE',[row.family_id,ctx.member.id])).rows[0];
     const allMembers=(await db.query('SELECT id,active,phone_number FROM appgastos.family_members WHERE family_id=$1',[row.family_id])).rows as Member[];
     if(!member?.active||normalizePhone(member.phone_number)!==row.sender||allMembers.filter(m=>m.active&&normalizePhone(m.phone_number)===row.sender).length!==1){
      reply='Este número ya no está autorizado. No se registró el gasto.';outcome='unauthorized';
     }else{
      try{
       const expense=await expenseService(pool,row.family_id).createExpense(validated.expense,'whatsapp',db);
       expenseId=expense.id;
       reply='Registrado: '+expense.currency+' '+expense.amount+' · '+(expense.merchant||expense.description)+' · '+expense.categoryName+(ctx.cards.find(c=>c.id===expense.cardId)?' · '+ctx.cards.find(c=>c.id===expense.cardId)!.name:'')+'.';
      }catch(error){
       if(!(error instanceof ApiError))throw error;
       reply='No registré el gasto: una referencia dejó de estar disponible. Revisa el mensaje y envíalo completo.';outcome='incomplete';
      }
     }
    }
    await db.query("UPDATE appgastos.whatsapp_messages SET state='completed',outcome=$3,expense_id=$4,reply_text=$5,completed_at=now(),text_body=NULL,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE message_id=$1 AND lease_token=$2",
     [row.message_id,row.lease_token,outcome,expenseId,reply]);
   });
  }catch(error){
   const code=error instanceof InterpretationError?'interpretation_retry':'processing_failed';
   await pool.query("UPDATE appgastos.whatsapp_messages SET state='pending',lease_token=NULL,lease_until=NULL,last_error=$3,next_attempt_at=now()+interval '15 seconds' WHERE message_id=$1 AND state='processing' AND lease_token=$2",[row.message_id,row.lease_token,code]);
   console.warn('whatsapp: '+code);
  }
  return true;
 }
 async function replyNext(){
  const row=await claim(pool,true);if(!row)return false;
  try{
   await send(row.sender,row.reply_text);
   await pool.query("UPDATE appgastos.whatsapp_messages SET reply_state='sent',reply_lease_token=NULL,reply_lease_until=NULL,last_error=NULL WHERE message_id=$1 AND reply_lease_token=$2",[row.message_id,row.reply_lease_token]);
  }catch{
   await pool.query("UPDATE appgastos.whatsapp_messages SET reply_state=$3,reply_lease_token=NULL,reply_lease_until=NULL,last_error='reply_failed',reply_next_attempt_at=now()+interval '30 seconds' WHERE message_id=$1 AND reply_lease_token=$2",[row.message_id,row.reply_lease_token,row.reply_attempts>=5?'failed':'pending']);
   console.warn('whatsapp: reply_failed');
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
