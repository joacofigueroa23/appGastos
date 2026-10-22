import type {Pool} from 'pg';
import {findExpense} from '../expenses/repository';
import {catalogRows} from '../family/repository';
import type {ApiExpense} from '../../shared/apiTypes';
import {InterpretationError,parseInterpretation,referenceDate,validateDraft,validatePatch,type CardEntry,type CatalogEntry,type DraftValidation,type InterpretationContext} from './candidate';
import {applyCandidatePatch,type DraftField,type DraftPatch,type ExpenseDraft} from './draft';
import {classifyPatch,deterministicAnswer,genericCardCorrection,hasCorrectionMarker,householdMarker,isCancel} from './intent';
import {findCorrectableExpense,type Conversation} from './conversation';
import {REPLIES,draftSummary,fieldNotice} from './replies';
import {conversationTtlMinutes} from './config';
import type {InboxRow} from './repository';
import type {Interpreter} from './interpretation';
export type Member=CatalogEntry&{phone_number:string|null;role?:'admin'|'member'};
export type Outcome='registered'|'incomplete'|'unauthorized'|'unsupported'|'interpretation_error'|'question'|'corrected'|'cancelled'|'pending_conflict'|'nothing_to_cancel'|'unrecognized'|'linked'|'link_failed'|'query'|'query_denied'|'document_received'|'document_rejected'|'document_ready'|'document_failed'|'document_command'|'admin_config'|'admin_denied';
export interface Catalog {familyCurrency:string;categories:CatalogEntry[];cards:CardEntry[];member:Member}
// Lo que decide un mensaje (fuera de la transacción); se aplica dentro de ella.
export type Decision=
 |{kind:'reply';outcome:Outcome;reply:string;failMembers?:string[]}
 |{kind:'interpretation_error';transient:boolean;lastError:string}
 |{kind:'rejected';errors:string[];editing:boolean}
 |{kind:'link';code:string}
 |{kind:'document';memberId:string;media:import('../documents/service').IncomingMedia}
 |{kind:'cancel'}|{kind:'conflict'}|{kind:'unknown'}
 |{kind:'update';draft:ExpenseDraft;result:DraftValidation;corrected:boolean;notice:string};
export const MAX_INTERPRETATION_ATTEMPTS=5;
export const CARD_METHODS:readonly string[]=['credit_card','debit_card'];
// Borrador de corrección a partir de un gasto guardado. referenceDate es hoy (para "ayer" en la corrección);
// la fecha del gasto se conserva como fecha explícita.
export function draftFromExpense(e:ApiExpense,today:string):ExpenseDraft{
 const draft:ExpenseDraft={referenceDate:today,editingExpenseId:e.id,amount:{value:e.amount,evidence:null},currency:{value:e.currency,evidence:null},
  date:{value:e.date,evidence:null},description:{value:e.description,evidence:null},category:{value:e.categoryId,evidence:null},paymentMethod:{value:e.paymentMethod,evidence:null}};
 if(e.merchant)draft.merchant={value:e.merchant,evidence:null};
 if(e.scope==='household')draft.scope='household';
 if(e.cardId||CARD_METHODS.includes(e.paymentMethod))draft.card={value:e.cardId,evidence:null};
 return draft;
}

export async function loadCatalog(pool:Pool,familyId:string,member:Member):Promise<Catalog>{
 const {defaultCurrency,categories,cards}=await catalogRows(pool,familyId);
 return {familyCurrency:defaultCurrency,categories,cards,member};
}
// Borrador con nombres reales para Gemini (sin ids ni datos ficticios).
function namedDraft(draft:ExpenseDraft,catalog:Catalog):Record<string,string|null>{
 return {amount:draft.amount?.value??null,currency:draft.currency?.value??null,date:draft.date?.value??null,merchant:draft.merchant?.value??null,
  category:draft.category?catalog.categories.find(c=>c.id===draft.category!.value)?.name??null:null,paymentMethod:draft.paymentMethod?.value??null,
  card:draft.card?draft.card.value===null?'ninguna':catalog.cards.find(c=>c.id===draft.card!.value)?.name??null:null};
}

export async function decide(pool:Pool,interpret:Interpreter,row:InboxRow,at:Date,catalog:Catalog,conversation:Conversation|null):Promise<Decision>{
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
 if(householdMarker(text))next.scope='household';
 return {kind:'update',draft:next,result:validateDraft(next,{...catalog,defaultCurrency:catalog.familyCurrency}),corrected:classified.intent==='correct'||reopened,notice:fieldNotice(Object.values(fieldErrors) as string[])};
}

