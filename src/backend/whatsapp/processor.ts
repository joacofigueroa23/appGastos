
import type {Pool,PoolClient} from 'pg';
import {expenseService} from '../expenses/service';
import {findExpense,transaction} from '../expenses/repository';
import {ApiError} from '../expenses/validation';
import type {ApiExpense} from '../../shared/apiTypes';
import {InterpretationError,parseInterpretation,referenceDate,validateDraft,validatePatch,type CardEntry,type CatalogEntry,type DraftValidation,type InterpretationContext} from './candidate';
import {applyCandidatePatch,type DraftField,type DraftPatch,type ExpenseDraft} from './draft';
import {classifyPatch,deterministicAnswer,genericCardCorrection,hasCorrectionMarker,isCancel} from './intent';
import {closeConversation,createConversation,expireConversations,failConversations,findActiveConversation,findCorrectableExpense,saveConversation,type Conversation} from './conversation';
import {REPLIES,confirmation,draftSummary,fieldNotice,questionFor} from './replies';
import {MAX_UNKNOWN_ANSWERS,conversationTtlMinutes} from './config';
import {normalizePhone} from './security';
import {claim,type InboxRow} from './repository';
import type {Interpreter} from './interpretation';
import type {ReplySender} from './transport';
type Member=CatalogEntry&{phone_number:string|null};
type Outcome='registered'|'incomplete'|'unauthorized'|'unsupported'|'interpretation_error'|'question'|'corrected'|'cancelled'|'pending_conflict'|'nothing_to_cancel'|'unrecognized';
interface Catalog {familyCurrency:string;categories:CatalogEntry[];cards:CardEntry[];member:Member}
// Lo que decide un mensaje (fuera de la transacción); se aplica dentro de ella.
type Decision=
 |{kind:'reply';outcome:Outcome;reply:string;failMembers?:string[]}
 |{kind:'interpretation_error';transient:boolean;lastError:string}
 |{kind:'rejected';errors:string[];editing:boolean}
 |{kind:'cancel'}|{kind:'conflict'}|{kind:'unknown'}
 |{kind:'update';draft:ExpenseDraft;result:DraftValidation;corrected:boolean;notice:string};
// La conversación cambió entre la lectura y la transacción: se reprocesa el mensaje.
class ConversationChanged extends Error {}
const MAX_INTERPRETATION_ATTEMPTS=5;
const CARD_METHODS:readonly string[]=['credit_card','debit_card'];
// Borrador de corrección a partir de un gasto guardado. referenceDate es hoy (para "ayer" en la corrección);
// la fecha del gasto se conserva como fecha explícita.
function draftFromExpense(e:ApiExpense,today:string):ExpenseDraft{
 const draft:ExpenseDraft={referenceDate:today,editingExpenseId:e.id,amount:{value:e.amount,evidence:null},currency:{value:e.currency,evidence:null},
  date:{value:e.date,evidence:null},description:{value:e.description,evidence:null},category:{value:e.categoryId,evidence:null},paymentMethod:{value:e.paymentMethod,evidence:null}};
 if(e.merchant)draft.merchant={value:e.merchant,evidence:null};
 if(e.cardId||CARD_METHODS.includes(e.paymentMethod))draft.card={value:e.cardId,evidence:null};
 return draft;
}

export function whatsappProcessor(pool:Pool,interpret:Interpreter,send:ReplySender){
 async function loadCatalog(familyId:string,member:Member):Promise<Catalog>{
  const family=(await pool.query('SELECT default_currency FROM appgastos.families WHERE id=$1',[familyId])).rows[0];
  const categories=(await pool.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1',[familyId])).rows as CatalogEntry[];
  const cards=(await pool.query('SELECT id,name,active,card_type AS "cardType" FROM appgastos.cards WHERE family_id=$1',[familyId])).rows as CardEntry[];
  return {familyCurrency:family.default_currency,categories,cards,member};
 }
 // Borrador con nombres reales para Gemini (sin ids ni datos ficticios).
 function namedDraft(draft:ExpenseDraft,catalog:Catalog):Record<string,string|null>{
  return {amount:draft.amount?.value??null,currency:draft.currency?.value??null,date:draft.date?.value??null,merchant:draft.merchant?.value??null,
   category:draft.category?catalog.categories.find(c=>c.id===draft.category!.value)?.name??null:null,paymentMethod:draft.paymentMethod?.value??null,
   card:draft.card?draft.card.value===null?'ninguna':catalog.cards.find(c=>c.id===draft.card!.value)?.name??null:null};
 }

 async function decide(row:InboxRow,at:Date,catalog:Catalog,conversation:Conversation|null):Promise<Decision>{
  const text=row.text_body!;
  if(isCancel(text))return conversation?{kind:'cancel'}:{kind:'reply',outcome:'nothing_to_cancel',reply:REPLIES.nothingToCancel};
  let draft:ExpenseDraft=conversation?.draft??{referenceDate:referenceDate(at)};
  // Corrección de un gasto YA registrado: frase de corrección, sin conversación abierta, y el último gasto
  // de este integrante por WhatsApp dentro de la ventana. El borrador parte del gasto guardado y al completarse lo edita.
  if(!conversation&&hasCorrectionMarker(text)){
   const expenseId=await findCorrectableExpense(pool,{familyId:row.family_id,sender:row.sender,memberId:catalog.member.id,at,windowMinutes:conversationTtlMinutes()});
   const expense=expenseId?await findExpense(pool,row.family_id,expenseId):null;
   if(expense)draft=draftFromExpense(expense,referenceDate(at));
  }
  const editing=!!draft.editingExpenseId,inContext=!!conversation||editing;
  const expected=conversation?.expectedField??null;
  const ctx:InterpretationContext={text,referenceDate:draft.referenceDate,defaultCurrency:catalog.familyCurrency,categories:catalog.categories,cards:catalog.cards,member:catalog.member,
   ...(inContext?{conversation:{draft:namedDraft(draft,catalog),expectedField:expected}}:{})};
  let patch:DraftPatch,fieldErrors:Partial<Record<DraftField,string>>={};
  // Respuesta corta al campo preguntado: reglas deterministas antes que Gemini.
  const quick=conversation?deterministicAnswer(expected,text,draft,catalog):null;
  if(quick?.kind==='patch')patch=quick.patch;
  else{
   let raw;
   if(quick)raw=quick.raw;
   else try{raw=parseInterpretation(await interpret(ctx));}
   catch(error){
    const transient=error instanceof InterpretationError&&error.message==='transient';
    // Un fallo pasajero de Gemini vuelve el mensaje a la cola sin tocar el borrador; agotados los intentos se informa.
    if(transient&&row.attempts<MAX_INTERPRETATION_ATTEMPTS)throw error;
    // Solo códigos técnicos (ej. interpretation_failed:http_404), nunca texto del mensaje.
    const lastError=error instanceof InterpretationError?'interpretation_'+error.message+(error.detail?':'+error.detail:''):'interpretation_unknown';
    console.warn('whatsapp: '+lastError);
    return {kind:'interpretation_error',transient,lastError};
   }
   const checked=validatePatch(raw,ctx,draft,{strict:!inContext,expected});
   if(checked.errors.length)return {kind:'rejected',errors:checked.errors,editing};
   patch=checked.patch;fieldErrors=checked.fieldErrors;
  }
  // "fue con tarjeta" sin crédito/débito ni nombre: el medio anterior (no tarjeta) deja de valer y se pregunta.
  let base=draft,reopened=false;
  if(inContext&&genericCardCorrection(text,catalog.cards)&&!(draft.paymentMethod&&CARD_METHODS.includes(draft.paymentMethod.value))){
   base={...draft};delete base.paymentMethod;delete base.card;reopened=true;
  }
  const summary=()=>draftSummary(draft,catalog,catalog.familyCurrency);
  const classified=classifyPatch(base,patch,text,expected);
  if(classified.intent==='conflict')return conversation?{kind:'conflict'}:{kind:'reply',outcome:'unrecognized',reply:REPLIES.correctionUnclear(summary())};
  const failed=Object.keys(fieldErrors) as DraftField[];
  if(classified.intent==='unknown'&&!failed.length&&!reopened){
   if(conversation)return {kind:'unknown'};
   return {kind:'reply',outcome:'unrecognized',reply:editing?REPLIES.correctionUnclear(summary()):REPLIES.help};
  }
  const next=applyCandidatePatch(base,classified.patch,failed);
  return {kind:'update',draft:next,result:validateDraft(next,{...catalog,defaultCurrency:catalog.familyCurrency}),corrected:classified.intent==='correct'||reopened,notice:fieldNotice(Object.values(fieldErrors) as string[])};
 }

 async function commit(db:PoolClient,row:InboxRow,at:Date,decision:Decision,catalog:Catalog|undefined,conversation:Conversation|null){
  const locked=(await db.query('SELECT state,lease_token FROM appgastos.whatsapp_messages WHERE message_id=$1 FOR UPDATE',[row.message_id])).rows[0];
  if(locked.state!=='processing'||locked.lease_token!==row.lease_token)return;
  let outcome:Outcome='incomplete',reply='',lastError:string|null=null,expenseId:string|null=null,conversationId:string|null=conversation?.id??null;
  const finish=()=>db.query("UPDATE appgastos.whatsapp_messages SET state='completed',outcome=$3,expense_id=$4,reply_text=$5,completed_at=now(),text_body=NULL,lease_token=NULL,lease_until=NULL,last_error=$6,conversation_id=$7 WHERE message_id=$1 AND lease_token=$2",
   [row.message_id,row.lease_token,outcome,expenseId,reply,lastError,conversationId]);
  if(decision.kind==='reply'&&decision.failMembers)await failConversations(db,row.family_id,decision.failMembers);
  if(catalog){
   const memberId=catalog.member.id;
   await expireConversations(db,row.family_id,memberId,at);
   const current=await findActiveConversation(db,row.family_id,memberId,true);
   if((current?.id??null)!==(conversation?.id??null)||(current&&conversation&&current.version!==conversation.version))throw new ConversationChanged();
   // El integrante debe seguir autorizado al momento de escribir.
   const member=(await db.query('SELECT active,phone_number FROM appgastos.family_members WHERE family_id=$1 AND id=$2 FOR SHARE',[row.family_id,memberId])).rows[0];
   const all=(await db.query('SELECT id,active,phone_number FROM appgastos.family_members WHERE family_id=$1',[row.family_id])).rows as Member[];
   if(!member?.active||normalizePhone(member.phone_number)!==row.sender||all.filter(m=>m.active&&normalizePhone(m.phone_number)===row.sender).length!==1){
    if(conversation)await closeConversation(db,conversation.id,'error');
    outcome='unauthorized';reply=REPLIES.noLongerAuthorized;await finish();return;
   }
  }
  // Repite la pregunta pendiente y guarda las opciones mostradas (el número elegido debe significar lo mismo).
  const ask=async(c:Conversation,unknownCount:number,prefix:string)=>{
   const question=questionFor(c.expectedField!,c.draft,catalog!);
   const draft={...c.draft};if(question.options)draft.options=question.options;else delete draft.options;
   await saveConversation(db,c.id,{draft,expectedField:c.expectedField,unknownCount});
   return prefix+question.text;
  };
  switch(decision.kind){
   case 'reply':outcome=decision.outcome;reply=decision.reply;if(outcome==='nothing_to_cancel'||outcome==='unauthorized'||outcome==='unsupported')conversationId=null;break;
   case 'interpretation_error':{
    outcome='interpretation_error';lastError=decision.lastError;
    const lead=decision.transient?REPLIES.unavailable:REPLIES.notInterpreted;
    reply=conversation?await ask(conversation,conversation.unknownCount,lead+REPLIES.keptDraft):
     lead+REPLIES.notRegistered+(decision.transient?'reenvía el mensaje en unos minutos.':'intenta con un texto completo o usa la carga manual.');
    break;
   }
   case 'rejected':
    if(conversation){outcome='unrecognized';reply=await ask(conversation,conversation.unknownCount,fieldNotice(decision.errors));}
    else{outcome='incomplete';reply=(decision.editing?'No corregí el gasto':'No registré el gasto')+'. Necesito revisar: '+decision.errors.join(', ')+'. Envía un nuevo mensaje.';}
    break;
   case 'cancel':
    await closeConversation(db,conversation!.id,'cancelled');outcome='cancelled';
    reply=conversation!.draft.editingExpenseId?REPLIES.cancelledEdit:REPLIES.cancelled;break;
   case 'conflict':outcome='pending_conflict';reply=REPLIES.conflict(draftSummary(conversation!.draft,catalog!,catalog!.familyCurrency));break;
   case 'unknown':{
    const count=conversation!.unknownCount+1;
    if(count>=MAX_UNKNOWN_ANSWERS){await closeConversation(db,conversation!.id,'cancelled');outcome='cancelled';reply=REPLIES.tooManyUnknown;}
    else{outcome='unrecognized';reply=await ask(conversation!,count,REPLIES.unknown);}
    break;
   }
   case 'update':{
    const {result,draft}=decision;
    if(result.valid&&result.expense&&draft.editingExpenseId){
     // Corrección de un gasto registrado: se edita con el servicio central, nunca se crea otro.
     // El mensaje no lleva expense_id (solo los mensajes que registran); la conversación sí.
     try{
      const expense=await expenseService(pool,row.family_id).update(draft.editingExpenseId,result.expense,db);
      const target=conversation??await createConversation(db,{familyId:row.family_id,memberId:catalog!.member.id,draft,expectedField:null,expiresAt:at});
      await closeConversation(db,target.id,'confirmed',expense.id);conversationId=target.id;outcome='corrected';
      reply=confirmation({amount:expense.amount,currency:expense.currency,familyCurrency:catalog!.familyCurrency,merchant:expense.merchant,
       categoryName:expense.categoryName,cardName:catalog!.cards.find(c=>c.id===expense.cardId)?.name??null,edited:true});
     }catch(error){
      if(!(error instanceof ApiError))throw error;
      if(conversation)await closeConversation(db,conversation.id,'error');
      outcome='incomplete';reply=REPLIES.editGone+'Corregilo desde la web.';
     }
     break;
    }
    if(result.valid&&result.expense){
     try{
      const expense=await expenseService(pool,row.family_id).createExpense(result.expense,'whatsapp',db);
      expenseId=expense.id;outcome='registered';
      if(conversation)await closeConversation(db,conversation.id,'confirmed',expense.id);
      // La confirmación usa los valores guardados en PostgreSQL, no los del borrador.
      reply=(decision.corrected?REPLIES.corrected:'')+confirmation({amount:expense.amount,currency:expense.currency,familyCurrency:catalog!.familyCurrency,merchant:expense.merchant,
       categoryName:expense.categoryName,cardName:catalog!.cards.find(c=>c.id===expense.cardId)?.name??null});
     }catch(error){
      if(!(error instanceof ApiError))throw error;
      outcome='incomplete';reply=REPLIES.referenceGone+'Revisa el mensaje y envíalo completo.';
     }
     break;
    }
    const field=result.missingFields[0];
    if(!field){
     outcome=conversation?'unrecognized':'incomplete';
     reply='No registré el gasto. Necesito revisar: '+result.validationErrors.join(', ')+'.';break;
    }
    const question=questionFor(field,draft,catalog!);
    const saved:ExpenseDraft={...draft,...(question.options?{options:question.options}:{})};
    // Cada mensaje válido renueva el vencimiento a partir de la hora del mensaje.
    const expiresAt=new Date(at.getTime()+conversationTtlMinutes()*60000);
    if(conversation)await saveConversation(db,conversation.id,{draft:saved,expectedField:field,unknownCount:0,expiresAt});
    else conversationId=(await createConversation(db,{familyId:row.family_id,memberId:catalog!.member.id,draft:saved,expectedField:field,expiresAt})).id;
    outcome=decision.corrected?'corrected':'question';
    reply=(decision.corrected?REPLIES.corrected:'')+decision.notice+fieldNotice(result.validationErrors)+question.text;
    break;
   }
  }
  await finish();
 }

 async function processNext(){
  const row=await claim(pool);if(!row)return false;
  try{
   // Hora real del mensaje: Meta si está, si no la recepción. Define fecha de referencia y vencimiento.
   const at=row.meta_timestamp??row.received_at;
   let decision:Decision,catalog:Catalog|undefined,conversation:Conversation|null=null;
   if(row.message_type!=='text')decision={kind:'reply',outcome:'unsupported',reply:REPLIES.unsupported};
   else{
    const members=(await pool.query('SELECT id,name,active,phone_number FROM appgastos.family_members WHERE family_id=$1',[row.family_id])).rows as Member[];
    const matches=members.filter(m=>m.active&&normalizePhone(m.phone_number)===row.sender);
    if(matches.length!==1){
     // Un número que dejó de estar autorizado no continúa conversaciones; no se llama a Gemini.
     const owners=members.filter(m=>normalizePhone(m.phone_number)===row.sender).map(m=>m.id);
     decision={kind:'reply',outcome:'unauthorized',reply:REPLIES.unauthorized,failMembers:owners};
    }else{
     catalog=await loadCatalog(row.family_id,matches[0]);
     conversation=await findActiveConversation(pool,row.family_id,matches[0].id);
     // Vencida: no se completa; se marca expired en la transacción y el mensaje es una interacción nueva.
     if(conversation&&new Date(conversation.expiresAt)<=at)conversation=null;
     decision=await decide(row,at,catalog,conversation);
    }
   }
   await transaction(pool,db=>commit(db,row,at,decision,catalog,conversation));
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
