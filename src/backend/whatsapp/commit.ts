import type {Pool,PoolClient} from 'pg';
import {expenseService} from '../expenses/service';
import {ApiError} from '../shared/errors';
import type {ExpenseDraft} from './draft';
import {closeConversation,createConversation,expireConversations,failConversations,findActiveConversation,saveConversation,type Conversation} from './conversation';
import {REPLIES,confirmation,draftSummary,fieldNotice,questionFor} from './replies';
import {MAX_UNKNOWN_ANSWERS,conversationTtlMinutes} from './config';
import {normalizePhone} from './security';
import type {InboxRow} from './repository';
import type {Catalog,Decision,Member,Outcome} from './decision';
import {attemptLink} from '../accounts/linking';
import {receiveDocument} from '../documents/service';
// La conversación cambió entre la lectura y la transacción: se reprocesa el mensaje.
export class ConversationChanged extends Error {}
export async function commit(pool:Pool,db:PoolClient,row:InboxRow,at:Date,decision:Decision,catalog:Catalog|undefined,conversation:Conversation|null){
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
  case 'document':{
   // Imagen o PDF de un integrante vinculado: crea el documento (aún no es un gasto) en esta misma transacción.
   const member=(await db.query('SELECT active,phone_number FROM appgastos.family_members WHERE family_id=$1 AND id=$2 FOR SHARE',[row.family_id,decision.memberId])).rows[0];
   if(!member?.active||normalizePhone(member.phone_number)!==row.sender){outcome='unauthorized';reply=REPLIES.noLongerAuthorized;conversationId=null;break;}
   const result=await receiveDocument(db,row,{id:decision.memberId},decision.media);
   outcome=result.outcome;reply=result.reply;conversationId=null;break;
  }
  case 'link':{
   // Vinculación de un número con una cuenta: sin Gemini ni conversación; se resuelve y completa en esta transacción.
   const result=await attemptLink(db,row.family_id,row.sender,decision.code);
   outcome=result.outcome;reply=result.reply;conversationId=null;break;
  }
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

