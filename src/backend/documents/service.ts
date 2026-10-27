import type {Pool} from 'pg';
import {randomInt,randomUUID} from 'node:crypto';
import {transaction,type Connection} from '../expenses/repository';
import {expenseService} from '../expenses/service';
import {fixedService,generateOccurrences} from '../fixed/service';
import {ApiError} from '../shared/errors';
import {referenceDate} from '../whatsapp/candidate';
import {conversationTtlMinutes} from '../whatsapp/config';
import {householdMarker} from '../whatsapp/intent';
import {documentLimits} from './limits';
import {declaredMime,DocumentError,failureReply,REJECTED_TYPE_REPLY,validateMedia} from './validate';
import type {MediaFetcher} from './media';
import type {DocumentExtractor} from './extraction';
import {applyEdit,BLOCKED,canAutoRegister,buildInvoiceDraft,buildReceiptDraft,buildStatementDraft,classify,receiptProblems,type DraftContext,type Edit} from './draft';
import {prepareBulkAction} from '../whatsapp/admin';
import {applyHint,captionHint,HINT_LABEL,listFromExtraction,type IntentHint} from './hint';
import {withFixedMatch,withReceiptDuplicates,withStatementDuplicates} from './duplicates';
import {fromCents,includedItems,primaryCategory,toCents} from './reconcile';
import {COMMAND_HELP,invoiceSummary,receiptSummary,statementSummary,unknownSummary} from './summary';
import {findCategory,findItem,parseAmountText,parseCommand,parseDateText} from './commands';
import type {DocumentKind,DocumentState,Draft,DraftLine,Extraction,InvoiceDraft,ReceiptDraft,StatementDraft} from './types';

export interface DocRow {
 id:string;family_id:string;member_id:string;sender:string|null;short_code:string;source_message_id:string|null;media_id:string;media_mime:string;media_sha256:string|null;
 filename:string|null;household_hint:boolean;intent_hint:IntentHint|null;state:DocumentState;kind:DocumentKind|null;attempts:number;extraction:Extraction|null;draft:Draft|null;result:any;usage:any;
 error_code:string|null;created_at:Date;updated_at:Date;expires_at:Date;lease_token:string|null;
}
// Una acción del usuario que no se puede cumplir (falta un dato, borrador cambiado): se le explica; no es un error del sistema.
export class DocumentActionError extends Error {}
export interface Viewer {memberId:string|null;role:'admin'|'member'}
// media_id de los comprobantes subidos desde la web (no hay archivo en Meta que descargar).
export const WEB_UPLOAD='web-upload';
const OPEN:DocumentState[]=['received','processing','needs_review'];
// Transiciones válidas: received → processing → needs_review → confirmed | cancelled; processing → received (reintento) | failed;
// cualquier estado abierto → cancelled (cancelación o vencimiento) o failed. confirmed, cancelled y failed son finales.
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode=()=>Array.from({length:4},()=>CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export async function loadContext(db:Connection,family:string):Promise<DraftContext>{
 const categories=(await db.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1 ORDER BY name',[family])).rows;
 const cards=(await db.query('SELECT id,name,active,card_type AS "cardType" FROM appgastos.cards WHERE family_id=$1 ORDER BY name',[family])).rows;
 const fam=(await db.query('SELECT default_currency FROM appgastos.families WHERE id=$1',[family])).rows[0];
 return {categories,cards,familyCurrency:fam.default_currency,today:referenceDate(new Date())};
}
// Respuesta asincrónica al usuario: se guarda como un mensaje de salida "completado" que el worker de respuestas ya sabe enviar.
const enqueueReply=async(db:Connection,doc:Pick<DocRow,'id'|'family_id'|'sender'>,suffix:string,outcome:string,text:string)=>{
 if(!doc.sender)return; // subido desde la web: no hay chat al que responder
 await db.query(`INSERT INTO appgastos.whatsapp_messages(message_id,family_id,sender,message_type,state,outcome,reply_text,completed_at) VALUES($1,$2,$3,'system','completed',$4,$5,now()) ON CONFLICT(message_id) DO NOTHING`,
  ['doc:'+doc.id+':'+suffix,doc.family_id,doc.sender,outcome,text]);
};
// Cierra el documento y vacía lo que leyó: no se conserva más de lo necesario.
async function finish(db:Connection,doc:Pick<DocRow,'id'>,state:'confirmed'|'cancelled'|'failed',error:string|null=null,result:unknown=null){
 const r=await db.query(`UPDATE appgastos.documents SET state=$2,result=$3,error_code=$4,extraction=NULL,draft=NULL,lease_token=NULL,lease_until=NULL,confirmed_at=CASE WHEN $2='confirmed' THEN now() ELSE confirmed_at END,updated_at=now()
  WHERE id=$1 AND state IN ('received','processing','needs_review')`,[doc.id,state,result===null?null:JSON.stringify(result),error]);
 if(!r.rowCount)throw new DocumentActionError('Ese comprobante ya fue cerrado.');
}

// ---- Recepción (dentro de la transacción que completa el mensaje: un mensaje repetido por Meta no crea otro documento).
export interface IncomingMedia {id:string;mime:string;sha256:string|null;filename:string|null;caption:string|null}
export async function receiveDocument(db:Connection,row:{message_id:string;family_id:string;sender:string},member:{id:string},media:IncomingMedia):Promise<{outcome:'document_received'|'document_rejected';reply:string}>{
 const limits=documentLimits();
 if(!declaredMime(media.mime))return {outcome:'document_rejected',reply:REJECTED_TYPE_REPLY};
 const recent=(await db.query("SELECT count(*)::int n FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND created_at>now()-interval '1 hour'",[row.family_id,member.id])).rows[0].n;
 if(recent>=limits.perHour)return {outcome:'document_rejected',reply:'Llegaste al límite de comprobantes por hora. Probá de nuevo más tarde o cargá el gasto a mano.'};
 const already=async()=>media.sha256?(await db.query("SELECT short_code,state FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND media_sha256=$3 AND state IN ('received','processing','needs_review','confirmed')",[row.family_id,member.id,media.sha256])).rows[0]:undefined;
 const repeat=(d:{short_code:string;state:string})=>({outcome:'document_received' as const,reply:'Ese comprobante ya lo recibí (código '+d.short_code+', '+(d.state==='confirmed'?'ya registrado':'todavía abierto')+'). No lo proceso otra vez.'});
 const known=await already();
 if(known)return repeat(known);
 const caption=media.caption||'';
 for(let attempt=0;attempt<6;attempt++){
  const code=newCode();
  const inserted=await db.query(`INSERT INTO appgastos.documents(family_id,member_id,sender,short_code,source_message_id,media_id,media_mime,media_sha256,filename,household_hint,intent_hint,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+($12||' hours')::interval) ON CONFLICT DO NOTHING RETURNING short_code`,
   [row.family_id,member.id,row.sender,code,row.message_id,media.id,media.mime.split(';')[0].trim().toLowerCase(),media.sha256,null,householdMarker(caption),captionHint(caption),String(limits.ttlHours)]);
  if(inserted.rowCount)return {outcome:'document_received',reply:'📎 Recibí tu comprobante (código '+code+'). Lo estoy leyendo y en un momento te cuento qué encontré. Todavía no registré nada.'};
  const concurrent=await already();
  if(concurrent)return repeat(concurrent);
 }
 return {outcome:'document_rejected',reply:'No pude registrar el comprobante ahora. Probá de nuevo en un momento.'};
}

// ---- Worker: lee los documentos recibidos. Con lease (contrato de alquiler del trabajo): si el servidor se reinicia a mitad de
// camino el lease vence y otro ciclo retoma el documento. Los reintentos no duplican nada: el resultado se guarda una sola vez.
export interface DocumentDeps {fetchMedia:MediaFetcher;extract:DocumentExtractor}
export function documentProcessor(pool:Pool,deps:DocumentDeps){
 async function claim():Promise<DocRow|null>{
  const token=randomUUID();
  return (await pool.query(`WITH picked AS (SELECT id FROM appgastos.documents WHERE next_attempt_at<=now() AND (state='received' OR (state='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   UPDATE appgastos.documents d SET state='processing',lease_token=$1,lease_until=now()+interval '180 seconds',attempts=attempts+1,updated_at=now() FROM picked WHERE d.id=picked.id RETURNING d.*`,[token])).rows[0]||null;
 }
 async function fail(doc:DocRow,error:unknown){
  const code=error instanceof DocumentError?error.code:'processing_failed',transient=error instanceof DocumentError?error.transient:true;
  console.warn('documents: '+code);
  if(transient&&doc.attempts<documentLimits().maxAttempts){
   await pool.query("UPDATE appgastos.documents SET state='received',lease_token=NULL,lease_until=NULL,error_code=$3,next_attempt_at=now()+($4||' seconds')::interval,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='processing'",[doc.id,doc.lease_token,code.replace(/[^a-z0-9_:]/g,'_').slice(0,80),String(30*doc.attempts)]);
   return;
  }
  await transaction(pool,async db=>{
   const locked=(await db.query("SELECT 1 FROM appgastos.documents WHERE id=$1 AND lease_token=$2 AND state='processing' FOR UPDATE",[doc.id,doc.lease_token])).rowCount;
   if(!locked)return;
   await finish(db,doc,'failed',code.replace(/[^a-z0-9_:]/g,'_').slice(0,80));
   await enqueueReply(db,doc,'failed','document_failed',failureReply(code));
  });
 }
 async function processNext():Promise<boolean>{
  const doc=await claim();
  if(!doc)return false;
  try{
   const limits=documentLimits();
   const fetched=await deps.fetchMedia(doc.media_id,Math.max(limits.maxImageBytes,limits.maxPdfBytes));
   const {mime}=validateMedia(fetched.bytes,doc.media_mime);
   const ctx=await loadContext(pool,doc.family_id);
   const owner=(await pool.query('SELECT role FROM appgastos.family_members WHERE id=$1',[doc.member_id])).rows[0];
   const {extraction:read,usage}=await deps.extract({bytes:fetched.bytes,mime,categories:ctx.categories.filter(c=>c.active).map(c=>c.name),today:ctx.today,familyCurrency:ctx.familyCurrency,hint:doc.intent_hint?HINT_LABEL[doc.intent_hint]:undefined});
   // La intención explícita del usuario (el texto que acompañó al archivo) pesa más que la clasificación del modelo.
   const {extraction,list}=applyHint(read,doc.intent_hint);
   await transaction(pool,async db=>{
    const viewer:Viewer={memberId:doc.member_id,role:owner.role};
    // Una lista de presupuestos o de gastos fijos no es un comprobante: se convierte en UNA acción de administración para confirmar.
    if(list){
     const lines=listFromExtraction(extraction,list);
     const closed=await db.query("UPDATE appgastos.documents SET state='cancelled',kind='unknown',extraction=NULL,draft=NULL,usage=$3,result=$4,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='processing'",
      [doc.id,doc.lease_token,JSON.stringify(usage),JSON.stringify({handedTo:'admin_action',kind:list})]);
     if(!closed.rowCount)return;
     const reply=owner.role==='admin'
      ?lines.length?(await prepareBulkAction(db,doc.family_id,{id:doc.member_id},{kind:list,items:lines},new Date(),ctx.familyCurrency)).reply
       :'Me dijiste que es '+(list==='budget'?'una lista de presupuestos':'una lista de gastos fijos')+' pero no pude leer las líneas con sus importes. ¿Me la mandás con una foto más nítida o por texto?'
      :'Eso parece una lista de '+(list==='budget'?'presupuestos':'gastos fijos')+'. Solo los administradores pueden configurarlos, así que no hice ningún cambio.';
     await enqueueReply(db,doc,'summary','document_ready',reply);
     return;
    }
    const built=await buildFor(db,doc,extraction,ctx,viewer);
    const r=await db.query(`UPDATE appgastos.documents SET state='needs_review',kind=$3,extraction=$4,draft=$5,usage=$6,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND state='processing'`,[doc.id,doc.lease_token,built.kind,JSON.stringify(extraction),built.draft?JSON.stringify(built.draft):null,JSON.stringify(usage)]);
    if(!r.rowCount)return; // otro proceso tomó el documento (lease vencido) o fue cancelado: no se pisa su resultado
    // Completo y sin dudas: el bot lo registra solo y avisa; si no, deja el borrador para que el usuario lo complete.
    const auto=await tryAutoRegister(pool,db,{...doc,kind:built.kind,extraction} as DocRow,built.draft,viewer,ctx);
    await enqueueReply(db,doc,auto?'registered':'summary',auto?'document_ready':'document_ready',auto??built.reply);
   });
  }catch(error){await fail(doc,error);}
  return true;
 }
 return {processNext};
}
// Arma el borrador según el tipo de documento y el texto de resumen para el usuario.
export async function buildFor(db:Connection,doc:Pick<DocRow,'family_id'|'member_id'|'short_code'|'household_hint'>,e:Extraction,ctx:DraftContext,viewer:Viewer){
 const kind=classify(e),dup={author:viewer.role==='member'?viewer.memberId??undefined:undefined,admin:viewer.role==='admin'};
 if(kind==='purchase_receipt'||kind==='payment_receipt'){
  let draft=await withReceiptDuplicates(db,doc.family_id,dup,buildReceiptDraft(e,ctx,kind,doc.household_hint));
  // Solo el administrador ve y puede saldar obligaciones fijas.
  if(viewer.role==='admin'&&kind==='payment_receipt')draft=await withFixedMatch(db,doc.family_id,draft);
  return {kind,draft:draft as Draft,reply:receiptSummary(draft,ctx,doc.short_code)};
 }
 if(kind==='pending_invoice'){const draft=buildInvoiceDraft(e,ctx);return {kind,draft:draft as Draft,reply:invoiceSummary(draft,viewer.role==='admin',ctx)};}
 if(kind==='card_statement'){
  const draft=await withStatementDuplicates(db,doc.family_id,dup,buildStatementDraft(e,ctx));
  return {kind,draft:draft as Draft,reply:statementSummary(draft,ctx,doc.short_code)};
 }
 return {kind:'unknown' as DocumentKind,draft:null as Draft|null,reply:unknownSummary(doc.short_code)};
}
// Comprobante subido desde la web: ya leído en el pedido, entra directo a revisión (sin chat, sin archivo guardado).
export async function createWebDocument(db:Connection,a:{family:string;member:string;mime:string;sha:string;kind:DocumentKind;extraction:Extraction;draft:Draft|null;usage:unknown;ttl:number}):Promise<DocRow>{
 for(let attempt=0;attempt<6;attempt++){
  const r=await db.query(`INSERT INTO appgastos.documents(family_id,member_id,sender,short_code,media_id,media_mime,media_sha256,state,kind,extraction,draft,usage,expires_at)
   VALUES($1,$2,NULL,$3,$4,$5,$6,'needs_review',$7,$8,$9,$10,now()+($11||' hours')::interval) ON CONFLICT DO NOTHING RETURNING *`,
   [a.family,a.member,newCode(),WEB_UPLOAD,a.mime,a.sha,a.kind,JSON.stringify(a.extraction),a.draft?JSON.stringify(a.draft):null,JSON.stringify(a.usage),String(a.ttl)]);
  if(r.rows[0])return r.rows[0];
 }
 throw new DocumentActionError('No pude registrar el comprobante ahora. Probá de nuevo en un momento.');
}
export async function expireDocuments(pool:Pool){
 await pool.query(`UPDATE appgastos.documents SET state='cancelled',error_code='expired',extraction=NULL,draft=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
  WHERE state IN ('received','processing','needs_review') AND expires_at<now() AND (lease_until IS NULL OR lease_until<now())`);
}

// ---- Acceso a documentos con permisos.
export async function lockDocument(db:Connection,family:string,id:string):Promise<DocRow|null>{
 return (await db.query('SELECT * FROM appgastos.documents WHERE family_id=$1 AND id=$2 FOR UPDATE',[family,id])).rows[0]||null;
}
// El dueño ve y opera su documento. El administrador además revisa las facturas pendientes de cualquiera (quedan para su revisión).
// Con Basic Auth (sin integrante) el acceso compartido equivale a administrador, como en el resto de la app.
export function canAccess(v:Viewer,doc:Pick<DocRow,'member_id'|'kind'>):boolean{
 return v.memberId===doc.member_id||(v.role==='admin'&&(doc.kind==='pending_invoice'||v.memberId===null));
}
// Operar (corregir, confirmar un gasto) es solo del dueño del comprobante: un administrador que revisa la factura de otro no puede
// reclasificarla ni registrar gastos a nombre de ese integrante. Con Basic Auth (sin integrante) el acceso compartido equivale a administrador.
export const canOperate=(v:Viewer,doc:Pick<DocRow,'member_id'>)=>v.memberId===doc.member_id||(v.role==='admin'&&v.memberId===null);
const asReceipt=(d:Draft|null):ReceiptDraft|null=>d&&(d.kind==='purchase_receipt'||d.kind==='payment_receipt')?d:null;
const duplicateViewer=(doc:DocRow,role:'admin'|'member')=>({author:role==='member'?doc.member_id:undefined,admin:role==='admin'});

// Aplica correcciones al borrador (las usan el chat y la web). No llama a Gemini ni crea movimientos.
export async function editDocument(db:Connection,doc:DocRow,edits:Edit[],role:'admin'|'member'):Promise<{draft:ReceiptDraft|StatementDraft;ctx:DraftContext}>{
 if(doc.state!=='needs_review')throw new DocumentActionError('Ese comprobante ya no se puede modificar.');
 const base=doc.draft;
 if(!base||base.kind==='pending_invoice')throw new DocumentActionError('Ese comprobante no se corrige así.');
 const ctx=await loadContext(db,doc.family_id);
 let draft:ReceiptDraft|StatementDraft=base;
 for(const edit of edits){
  const r=applyEdit(draft,edit,ctx);
  if(r.error!==undefined)throw new DocumentActionError(r.error);
  draft=r.draft;
 }
 // Cambiar fecha o total cambia con qué gastos podría coincidir.
 if(draft.kind!=='card_statement'&&edits.some(e=>e.type==='date'||e.type==='total'))draft=await withReceiptDuplicates(db,doc.family_id,duplicateViewer(doc,role),draft);
 await db.query("UPDATE appgastos.documents SET draft=$2,updated_at=now() WHERE id=$1 AND state='needs_review'",[doc.id,JSON.stringify(draft)]);
 return {draft,ctx};
}
// "Es un ticket / factura / resumen": se rearma el borrador con lo que ya se leyó, sin volver a llamar al modelo.
export async function changeKind(db:Connection,doc:DocRow,kind:DocumentKind,role:'admin'|'member'):Promise<{reply:string;draft:Draft|null}>{
 if(doc.state!=='needs_review'||!doc.extraction)throw new DocumentActionError('Ese comprobante ya no se puede modificar.');
 if(kind==='card_statement'&&!doc.extraction.lines.length)throw new DocumentActionError('No encontré movimientos para un resumen de tarjeta.');
 const ctx=await loadContext(db,doc.family_id);
 // Lo que el usuario afirma pesa más que la clasificación del modelo; no se inventa que algo esté pagado.
 const e:Extraction={...doc.extraction,documentType:kind,paymentStatus:kind==='purchase_receipt'||kind==='payment_receipt'?'unknown':doc.extraction.paymentStatus};
 const built=await buildFor(db,doc,e,ctx,{memberId:doc.member_id,role});
 await db.query("UPDATE appgastos.documents SET kind=$2,draft=$3,updated_at=now() WHERE id=$1 AND state='needs_review'",[doc.id,built.kind,built.draft?JSON.stringify(built.draft):null]);
 return {reply:built.reply,draft:built.draft};
}
export async function cancelDocument(db:Connection,doc:DocRow):Promise<string>{
 if(doc.state==='cancelled')return 'Ese comprobante ya estaba descartado.';
 if(doc.state==='confirmed')throw new DocumentActionError('Ese comprobante ya está registrado: no se puede descartar. Si hay que corregirlo, hacelo desde el Historial.');
 await finish(db,doc,'cancelled');
 return '🗑️ Descarté el comprobante '+doc.short_code+'. No registré nada.';
}

// ---- Confirmación. Cada una corre dentro de UNA transacción: o se registra todo o nada. Confirmar dos veces no duplica.
const SOURCE='whatsapp' as const;
async function attachItems(db:Connection,family:string,expenseId:string,items:{description:string;categoryId:string|null;amount:string}[]){
 let position=0;
 for(const i of items)await db.query('INSERT INTO appgastos.expense_items(expense_id,family_id,position,description,category_id,amount) VALUES($1,$2,$3,$4,$5,$6)',[expenseId,family,position++,i.description.slice(0,300),i.categoryId,i.amount]);
}
export async function confirmDocument(pool:Pool,db:Connection,doc:DocRow,viewer:Viewer,input:{occurrenceId?:string;newFixedCategoryId?:string}={}):Promise<string>{
 if(!canOperate(viewer,doc)&&doc.draft?.kind!=='pending_invoice')throw new DocumentActionError('Solo quien mandó el comprobante puede registrarlo.');
 if(doc.state==='confirmed')return 'Ese comprobante ya estaba registrado (código '+doc.short_code+'). No se registró nada de nuevo.';
 if(doc.state!=='needs_review'||!doc.draft)throw new DocumentActionError(doc.state==='cancelled'?'Ese comprobante fue descartado.':'Todavía estoy leyendo ese comprobante.');
 const ctx=await loadContext(db,doc.family_id);
 const draft=doc.draft;
 const owner:Viewer={memberId:doc.member_id,role:viewer.role};
 const svc=expenseService(pool,doc.family_id,{role:'member',memberId:doc.member_id});
 if(draft.kind==='pending_invoice')return applyInvoice(db,doc,draft,viewer,input);
 if(draft.kind==='card_statement'){
  const chosen=draft.lines.filter(l=>!l.excluded);
  if(!chosen.length)throw new DocumentActionError('No elegiste ningún movimiento para importar.');
  const problems:string[]=[];
  for(const l of chosen){
   if(l.blockedReason)problems.push(l.merchant+': no se puede importar ('+(BLOCKED[l.blockedReason]||'bloqueado')+')');
   else if(l.kind==='refund'){if(!l.refundOf)problems.push('el gasto original de la devolución «'+l.merchant+'»');}
   else if(!l.categoryId||!ctx.categories.some(c=>c.id===l.categoryId&&c.active))problems.push('categoría de «'+l.merchant+'»');
   else if(!l.date)problems.push('fecha de «'+l.merchant+'»');
  }
  if(draft.cardId&&!ctx.cards.some(c=>c.id===draft.cardId&&c.active))problems.push('una tarjeta válida');
  if(problems.length)throw new DocumentActionError('Antes de importar falta: '+problems.slice(0,6).join(', ')+(problems.length>6?' y '+(problems.length-6)+' más':'')+'.');
  const card=ctx.cards.find(c=>c.id===draft.cardId);
  const ids:string[]=[],refunds:{expenseId:string;amount:string}[]=[];
  // Primero las compras y después las devoluciones: una devolución puede restar de una compra que se importa en este mismo resumen.
  for(const l of chosen.filter(x=>x.kind!=='refund')){
   // Compra en cuotas (cuota 1): se registra una sola vez por el total de la compra, con la cantidad de meses.
   const total=l.installment?fromCents(toCents(l.amount)*l.installment.total):l.amount;
   const e=await svc.createExpense({date:l.date,amount:total,currency:l.currency,merchant:l.merchant,description:l.installment?l.merchant+' ('+l.installment.total+' cuotas)':l.merchant,categoryId:l.categoryId,paymentMethod:card?.cardType??(doc.media_id===WEB_UPLOAD?'other':'credit_card'),cardId:draft.cardId,scope:l.scope},SOURCE,db);
   await db.query('UPDATE appgastos.expenses SET document_id=$2,installments=$3 WHERE id=$1',[e.id,doc.id,l.installment?l.installment.total:null]);
   ids.push(e.id);
  }
  for(const l of chosen.filter(x=>x.kind==='refund')){await applyRefund(db,doc,viewer.role,l);refunds.push({expenseId:l.refundOf!,amount:l.amount});}
  await finish(db,doc,'confirmed',null,{expenseIds:ids,count:ids.length,refunds});
  return '✅ Importé '+ids.length+' consumos del resumen'+(refunds.length?' y apliqué '+refunds.length+' devolución(es) restando del gasto original':'')+'. Los que dejaste afuera no se registraron.';
 }
 // Ticket o comprobante de pago.
 // Saldar una obligación fija: si ya estaba pagada no se crea otro gasto; si no, se registra UN gasto de la casa y se vincula (el pago no consume presupuesto variable).
 let settleOccurrence:string|null=null;
 if(draft.settle&&!draft.noExpense&&!draft.linkExpenseId){
  if(viewer.role!=='admin')throw new DocumentActionError('Solo un administrador puede saldar una obligación fija.');
  const o=(await db.query('SELECT id,expense_id FROM appgastos.fixed_expense_occurrences WHERE family_id=$1 AND id=$2 FOR UPDATE',[doc.family_id,draft.settle.occurrenceId])).rows[0];
  if(!o)throw new DocumentActionError('Esa obligación ya no existe. Respondé *no es gasto fijo* para registrarlo como un gasto común.');
  if(o.expense_id){await finish(db,doc,'confirmed',null,{noExpense:true,reason:'La obligación ya estaba pagada: no creé otro gasto.'});return '✅ «'+draft.settle.label+'» ya figuraba como pagado. No creé otro gasto.';}
  settleOccurrence=o.id;
 }
 if(draft.noExpense){await finish(db,doc,'confirmed',null,{noExpense:true,reason:draft.noExpenseReason});return '✅ Listo: no registré ningún gasto ('+(draft.noExpenseReason||'indicaste que no lo es')+').';}
 if(draft.linkExpenseId){
  const r=await db.query('UPDATE appgastos.expenses SET document_id=$2 WHERE family_id=$1 AND id=$3 AND document_id IS NULL'+(owner.role==='member'?' AND reported_by_member_id=$4':'')+' RETURNING id',
   [doc.family_id,doc.id,draft.linkExpenseId,...(owner.role==='member'?[doc.member_id]:[])]);
  if(!r.rowCount)throw new DocumentActionError('El gasto con el que coincidía ya no está disponible. Respondé *no vincular* para crear uno nuevo.');
  await finish(db,doc,'confirmed',null,{linkedExpenseId:draft.linkExpenseId});
  return '✅ Asocié el comprobante al gasto que ya habías cargado. No se creó otro.';
 }
 const problems=receiptProblems(draft,ctx);
 if(problems.length)throw new DocumentActionError('Todavía falta: '+problems.join(', ')+'.');
 const items=includedItems(draft);
 const categoriesUsed=new Set(items.map(i=>i.categoryId));
 const expense=await svc.createExpense({
  date:draft.date,amount:draft.total,currency:draft.currency,merchant:draft.merchant,description:draft.description,
  categoryId:categoriesUsed.size>1?primaryCategory(items):items[0].categoryId,paymentMethod:draft.paymentMethod,cardId:draft.cardId,scope:settleOccurrence?'household':draft.scope,
 },SOURCE,db);
 if(settleOccurrence){
  await db.query('UPDATE appgastos.fixed_expense_occurrences SET expense_id=NULL,link_source=NULL WHERE expense_id=$1 AND id<>$2',[expense.id,settleOccurrence]);
  await db.query("UPDATE appgastos.fixed_expense_occurrences SET expense_id=$2,link_source='manual' WHERE id=$1 AND (expense_id IS NULL OR expense_id=$2)",[settleOccurrence,expense.id]);
 }
 // Con varias categorías el gasto guarda sus conceptos; la suma coincide con el total (lo exige también la base al cerrar la transacción).
 if(categoriesUsed.size>1)await attachItems(db,doc.family_id,expense.id,items);
 await db.query('UPDATE appgastos.expenses SET document_id=$2 WHERE id=$1',[expense.id,doc.id]);
 await finish(db,doc,'confirmed',null,{expenseId:expense.id,categories:categoriesUsed.size,settledOccurrenceId:settleOccurrence});
 if(settleOccurrence)return '✅ Registré el pago de «'+draft.settle!.label+'» por '+draft.total!.replace(/\.00$/,'')+' '+draft.currency+'. La obligación quedó pagada y no descuenta de tus presupuestos.';
 const catName=(id:string|null)=>ctx.categories.find(c=>c.id===id)?.name;
 return '✅ Registrado: '+draft.description+' por '+draft.total!.replace(/\.00$/,'')+' '+draft.currency+(categoriesUsed.size>1?' repartido en '+categoriesUsed.size+' categorías':catName(items[0].categoryId)?' en '+catName(items[0].categoryId):'')+'.';
}
// Registro automático: se intenta dentro de un SAVEPOINT; si algo falla, se deshace solo eso y el comprobante queda como borrador normal.
export const UNDO_HINT='\nSi está mal, respondé *deshacer* y lo borro.';
export async function tryAutoRegister(pool:Pool,db:Connection,doc:DocRow,draft:Draft|null,viewer:Viewer,ctx:DraftContext):Promise<string|null>{
 if(!draft||(draft.kind!=='purchase_receipt'&&draft.kind!=='payment_receipt')||!canAutoRegister(draft,ctx))return null;
 await db.query('SAVEPOINT auto_register');
 try{
  const message=await confirmDocument(pool,db,{...doc,state:'needs_review',draft},viewer);
  await db.query('RELEASE SAVEPOINT auto_register');
  return message+UNDO_HINT;
 }catch(error){
  await db.query('ROLLBACK TO SAVEPOINT auto_register');
  if(error instanceof DocumentActionError||error instanceof ApiError)return null;
  throw error;
 }
}
// "Deshacer": borra el gasto que el bot registró solo (o que confirmaste hace poco) y deja el comprobante descartado. Solo los últimos 60 minutos y solo lo tuyo.
async function undoLast(db:Connection,family:string,member:{id:string}):Promise<string>{
 const doc=(await db.query(`SELECT id,result FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state='confirmed' AND result->>'expenseId' IS NOT NULL AND confirmed_at>now()-interval '60 minutes' ORDER BY confirmed_at DESC LIMIT 1 FOR UPDATE`,[family,member.id])).rows[0];
 if(!doc)return 'No encontré nada reciente para deshacer (solo puedo deshacer lo registrado en la última hora). Para borrar un gasto usá el Historial.';
 await db.query('DELETE FROM appgastos.expenses WHERE family_id=$1 AND id=$2 AND reported_by_member_id=$3',[family,doc.result.expenseId,member.id]);
 await db.query("UPDATE appgastos.documents SET state='cancelled',result=$2,updated_at=now() WHERE id=$1",[doc.id,JSON.stringify({undone:true})]);
 return '↩️ Listo, borré el gasto que acababa de registrar. El comprobante quedó descartado.';
}
// Una devolución resta del gasto original (regla aprobada): amount queda neto y refunded_amount deja constancia. Si el gasto tiene conceptos,
// se agrega un concepto negativo en su categoría principal para que la suma siga siendo el importe (la base también lo exige).
async function applyRefund(db:Connection,doc:DocRow,role:'admin'|'member',l:DraftLine){
 const e=(await db.query('SELECT amount::text AS amount,currency,reported_by_member_id AS author FROM appgastos.expenses WHERE family_id=$1 AND id=$2 FOR UPDATE',[doc.family_id,l.refundOf])).rows[0];
 if(!e||(role==='member'&&e.author!==doc.member_id))throw new DocumentActionError('El gasto original de la devolución «'+l.merchant+'» ya no está disponible.');
 if(e.currency!==l.currency||toCents(e.amount)<=toCents(l.amount))throw new DocumentActionError('La devolución de «'+l.merchant+'» no se puede restar: el gasto original no alcanza (una devolución total se resuelve borrando el gasto desde el Historial).');
 const top=(await db.query('SELECT category_id FROM appgastos.expense_items WHERE expense_id=$1 ORDER BY amount DESC,position LIMIT 1',[l.refundOf])).rows[0];
 if(top)await db.query("INSERT INTO appgastos.expense_items(expense_id,family_id,position,description,category_id,amount) SELECT $1,$2,COALESCE(max(position),-1)+1,$4,$3,-$5::numeric FROM appgastos.expense_items WHERE expense_id=$1",[l.refundOf,doc.family_id,top.category_id,('Devolución '+l.merchant).slice(0,300),l.amount]);
 await db.query('UPDATE appgastos.expenses SET amount=amount-$2::numeric,refunded_amount=refunded_amount+$2::numeric WHERE id=$1',[l.refundOf,l.amount]);
}
// Una factura pendiente NUNCA crea un gasto. Un administrador puede asociarla a un gasto fijo de su mes: actualiza el importe y el
// vencimiento previstos de esa ocurrencia (no la marca pagada: eso ocurre solo cuando se registra el pago real).
// Sin gasto fijo previo (decisión aprobada), el administrador puede crear la obligación nueva a partir de la factura: un gasto fijo de una sola
// cuota, con el vencimiento y el importe de la factura. Tampoco queda pagada.
async function applyInvoice(db:Connection,doc:DocRow,draft:InvoiceDraft,viewer:Viewer,input:{occurrenceId?:string;newFixedCategoryId?:string}):Promise<string>{
 if(viewer.role!=='admin')throw new DocumentActionError('Solo un administrador puede revisar facturas pendientes.');
 let occurrenceId=input.occurrenceId;
 if(!occurrenceId&&input.newFixedCategoryId){
  if(!draft.amount||toCents(draft.amount)<=0||!draft.dueDate)throw new DocumentActionError('Para crear la obligación hace falta que la factura tenga importe y vencimiento legibles.');
  if(draft.currency!==(await loadContext(db,doc.family_id)).familyCurrency)throw new DocumentActionError('Por ahora las obligaciones se crean solo en la moneda de la familia.');
  const fixed=fixedService(db as unknown as Pool,doc.family_id);
  const created=await fixed.create({name:(draft.issuer||draft.concept||'Factura').slice(0,120),categoryId:input.newFixedCategoryId,expectedAmount:draft.amount,dueDay:Number(draft.dueDate.slice(8,10)),startDate:draft.dueDate.slice(0,7)+'-01',installmentsTotal:1});
  await generateOccurrences(db,doc.family_id,draft.dueDate.slice(0,7));
  occurrenceId=(await db.query('SELECT id FROM appgastos.fixed_expense_occurrences WHERE family_id=$1 AND fixed_expense_id=$2',[doc.family_id,created.id])).rows[0]?.id;
 }
 if(!occurrenceId)throw new DocumentActionError('Elegí a qué gasto fijo corresponde, creá una obligación nueva o descartá la factura.');
 const o=(await db.query(`SELECT o.id,o.expense_id,f.currency FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id WHERE o.family_id=$1 AND o.id=$2 FOR UPDATE OF o`,[doc.family_id,occurrenceId])).rows[0];
 if(!o)throw new DocumentActionError('Ese gasto fijo no existe.');
 if(o.expense_id)throw new DocumentActionError('Esa obligación ya está pagada.');
 if(draft.amount&&draft.currency!==o.currency)throw new DocumentActionError('La factura está en otra moneda que ese gasto fijo.');
 if(draft.amount&&toCents(draft.amount)>0)await db.query('UPDATE appgastos.fixed_expense_occurrences SET expected_amount=$2 WHERE id=$1',[o.id,draft.amount]);
 if(draft.dueDate)await db.query('UPDATE appgastos.fixed_expense_occurrences SET due_date=$2::date WHERE id=$1',[o.id,draft.dueDate]);
 await finish(db,doc,'confirmed',null,{occurrenceId:o.id,amount:draft.amount,dueDate:draft.dueDate});
 return 'Factura asociada al gasto fijo. Sigue pendiente de pago hasta que se registre el pago.';
}

// Respuesta corta a lo que el bot preguntó sobre un comprobante abierto, sin comando: «ayer», «20 mil», «Combustible». Solo con UN comprobante abierto
// y fresco, sin un gasto en curso, y solo si lo escrito encaja con lo que se preguntó (un gasto nuevo, «gasté 500 en…», no se confunde).
export function bareEdit(draft:ReceiptDraft,text:string,ctx:DraftContext):Edit[]|null{
 const t=text.trim().replace(/[.!¡¿?]+$/g,'');
 if(!t||t.split(/\s+/).length>4)return null;
 if(draft.noExpense||draft.linkExpenseId)return null;
 if(draft.total===null||toCents(draft.total)<=0){
  if(!/^[\s$]*[\d.,]+\s*(?:mil|k|lucas|pesos)?\s*$/i.test(t))return null;
  const v=parseAmountText(t);return v?[{type:'total',value:v}]:null;
 }
 if(!draft.date){
  if(!/^(?:hoy|ayer|anteayer|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)$/i.test(t))return null;
  const v=parseDateText(t,ctx.today);return v?[{type:'date',value:v}]:null;
 }
 const target=includedItems(draft).find(i=>!i.adjustment&&!i.categoryId)??includedItems(draft).find(i=>i.adjustment&&!i.categoryId);
 if(!target)return null;
 const c=findCategory(ctx.categories,t.replace(/^(?:en |va en |ponelo en |ponela en |la categoria |categoria )+/i,'').trim());
 return c?[{type:'itemCategory',itemId:target.id,categoryId:c.id}]:null;
}
async function bareAnswer(pool:Pool,db:Connection,member:{id:string;role:'admin'|'member'},family:string,text:string,hasConversation:boolean):Promise<{outcome:'document_command';reply:string}|null>{
 if(hasConversation)return null;
 const open:DocRow[]=(await db.query("SELECT * FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state='needs_review' AND kind IN ('purchase_receipt','payment_receipt') AND draft IS NOT NULL ORDER BY created_at FOR UPDATE",[family,member.id])).rows;
 const doc=open[0],draft=asReceipt(doc?.draft??null);
 if(open.length!==1||!draft||Date.now()-new Date(doc.updated_at).getTime()>conversationTtlMinutes()*60000)return null;
 const ctx=await loadContext(db,family),edits=bareEdit(draft,text,ctx);
 if(!edits)return null;
 try{
  const edited=await editDocument(db,doc,edits,member.role);
  const auto=await tryAutoRegister(pool,db,doc,edited.draft,{memberId:member.id,role:member.role},ctx);
  return {outcome:'document_command',reply:auto??receiptSummary(edited.draft as ReceiptDraft,ctx,doc.short_code)};
 }catch(error){
  if(error instanceof DocumentActionError||error instanceof ApiError)return {outcome:'document_command',reply:error.message+' '+COMMAND_HELP};
  throw error;
 }
}

// ---- Texto del usuario sobre sus comprobantes abiertos. Devuelve null si el mensaje no es para un comprobante (sigue su camino normal).
export async function documentCommand(pool:Pool,db:Connection,member:{id:string;role:'admin'|'member'},family:string,text:string,hasConversation:boolean):Promise<{outcome:'document_command';reply:string}|null>{
 const cmd=parseCommand(text);
 if(!cmd)return bareAnswer(pool,db,member,family,text,hasConversation);
 const code=('code' in cmd&&cmd.code?cmd.code.toUpperCase():undefined);
 if(cmd.type==='undo')return {outcome:'document_command' as const,reply:await undoLast(db,family,member)};
 const open:DocRow[]=(await db.query("SELECT * FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state IN ('received','processing','needs_review') ORDER BY created_at FOR UPDATE",[family,member.id])).rows;
 const say=(reply:string)=>({outcome:'document_command' as const,reply});
 // Confirmar de nuevo algo ya registrado (doble toque, reintento) devuelve el resultado sin registrar otra vez. Con código se busca
 // sin límite de tiempo; sin código, solo lo confirmado hace poco.
 const alreadyConfirmed=async()=>cmd.type!=='confirm'?undefined:(await db.query(`SELECT short_code FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state='confirmed'
  AND ($3::text IS NULL OR short_code=$3) AND ($3::text IS NOT NULL OR confirmed_at>now()-interval '10 minutes') ORDER BY confirmed_at DESC LIMIT 1`,[family,member.id,code??null])).rows[0] as {short_code:string}|undefined;
 const repeated=(d:{short_code:string})=>say('Ese comprobante ya estaba registrado (código '+d.short_code+'). No se registró nada de nuevo.');
 if(!open.length){
  const done=await alreadyConfirmed();
  return done?repeated(done):code?say('No encontré un comprobante abierto con ese código.'):null;
 }
 // Con una conversación de gasto abierta, "sí" / "cancelar" son de esa conversación: para el comprobante hace falta el código.
 if(hasConversation&&!code)return null;
 let doc:DocRow|undefined;
 if(code){doc=open.find(d=>d.short_code===code);if(!doc){const done=await alreadyConfirmed();return done?repeated(done):say('No encontré un comprobante abierto con el código '+code+'.');}}
 else if(open.length===1)doc=open[0];
 else return say('Tenés varios comprobantes abiertos: '+open.map(d=>d.short_code).join(', ')+'. Indicá el código, por ejemplo «confirmar '+open[0].short_code+'».');
 // Un "ok" suelto no debe confirmar un borrador viejo por accidente: pasado un rato se exige el código.
 if(!code&&Date.now()-new Date(doc.updated_at).getTime()>conversationTtlMinutes()*60000)
  return say('Tenés un comprobante abierto desde hace un rato (código '+doc.short_code+'). Para operarlo indicá el código, por ejemplo «confirmar '+doc.short_code+'».');
 if(doc.state!=='needs_review')return say('Todavía estoy leyendo el comprobante '+doc.short_code+'. En un momento te cuento qué encontré.');
 try{
  const ctx=await loadContext(db,family);
  const show=(d:Draft|null)=>d?d.kind==='card_statement'?statementSummary(d,ctx,doc!.short_code):d.kind==='pending_invoice'?invoiceSummary(d,member.role==='admin',ctx):receiptSummary(d,ctx,doc!.short_code):unknownSummary(doc!.short_code);
  switch(cmd.type){
   case 'confirm':
    if(doc.kind==='card_statement')return say('Los resúmenes de tarjeta se revisan en la web (Comprobantes): ahí elegís qué importar.');
    if(doc.kind==='pending_invoice')return say(member.role==='admin'?'Las facturas pendientes se revisan en la web (Comprobantes).':'Esa factura queda pendiente de revisión por un administrador.');
    {
     // «Sí» a la pregunta del ajuste («¿lo sumo a Combustible?»): se asigna a la categoría principal y se sigue. Si todavía falta otra cosa,
     // se pregunta eso (una cosa por vez) en vez de listar errores.
     let target=doc;
     const current=asReceipt(doc.draft);
     if(current){
      const pendingAdjustments=current.items.filter(i=>i.adjustment&&!i.excluded&&!i.categoryId),primary=primaryCategory(includedItems(current).filter(i=>!i.adjustment));
      if(pendingAdjustments.length&&primary){const edited=await editDocument(db,doc,pendingAdjustments.map(i=>({type:'itemCategory' as const,itemId:i.id,categoryId:primary})),member.role);target={...doc,draft:edited.draft};}
     }
     try{return say(await confirmDocument(pool,db,target,{memberId:member.id,role:member.role}));}
     catch(error){const draft=asReceipt(target.draft);if(error instanceof DocumentActionError&&draft&&!draft.noExpense&&!draft.linkExpenseId)return say(show(draft));throw error;}
    }
   case 'cancel':return say(await cancelDocument(db,doc));
   case 'kind':return say((await changeKind(db,doc,cmd.value,member.role)).reply);
   case 'configList':{
    // «Es una lista de presupuestos / de gastos fijos»: con lo que ya se leyó, sin volver a llamar al modelo. Solo administradores.
    if(member.role!=='admin'){await cancelDocument(db,doc);return say('Eso es configuración y solo los administradores pueden cargarla. Descarté el archivo, no hice ningún cambio.');}
    if(!doc.extraction)return say('Ya no tengo lo que leí de ese archivo. Mandalo de nuevo.');
    const lines=listFromExtraction(doc.extraction,cmd.kind);
    if(!lines.length)return say('No pude leer líneas con importes en ese archivo. ¿Me lo mandás más nítido o por texto?');
    const prepared=await prepareBulkAction(db,family,{id:member.id},{kind:cmd.kind,items:lines},new Date(),ctx.familyCurrency);
    await finish(db,doc,'cancelled',null,{handedTo:'admin_action',kind:cmd.kind});
    return say(prepared.reply);
   }
  }
  const d=doc.draft;
  if(!d||d.kind==='pending_invoice')return say(show(d)+'\nEse comprobante no se corrige por acá.');
  if(d.kind==='card_statement')return say('Los resúmenes se corrigen en la web (Comprobantes).');
  let edits:Edit[]=[];
  switch(cmd.type){
   case 'scope':edits=[{type:'scope',value:cmd.value}];break;
   case 'payment':edits=[{type:'paymentMethod',value:cmd.value}];break;
   case 'noExpense':edits=[{type:'noExpense',value:true}];break;
   case 'expense':edits=[{type:'noExpense',value:false}];break;
   case 'link':if(!d.duplicates.length)return say('No encontré un gasto parecido para asociar.');if(d.duplicates.length>1&&!d.linkExpenseId)return say('Hay varios gastos parecidos: asocialo desde la web (Comprobantes).');edits=[{type:'link',expenseId:d.linkExpenseId||d.duplicates[0].expenseId}];break;
   case 'unlink':edits=[{type:'link',expenseId:null}];break;
   case 'unsettle':if(!d.settle)return say('Ese comprobante no está asociado a un gasto fijo.');edits=[{type:'settle',occurrenceId:null}];break;
   case 'date':{const v=parseDateText(cmd.raw,ctx.today);if(!v)return say('No entendí esa fecha. Probá con «fecha 10/10» o «fecha ayer».');edits=[{type:'date',value:v}];break;}
   case 'total':{const v=parseAmountText(cmd.raw);if(!v)return say('No entendí ese total. Probá con «total 19000».');edits=[{type:'total',value:v}];break;}
   case 'exclude':{const item=findItem(d,cmd.item);if(!item)return null;edits=[{type:'itemExcluded',itemId:item.id,excluded:true}];break;}
   case 'itemCategory':{
    const item=findItem(d,cmd.item);
    if(!item)return null; // "gasté 500 en kiosco" no es un comando de este comprobante
    const category=findCategory(ctx.categories,cmd.category);
    if(!category)return say('No encontré la categoría «'+cmd.category+'». Las categorías válidas son: '+ctx.categories.filter(c=>c.active).map(c=>c.name).join(', ')+'.');
    edits=[{type:'itemCategory',itemId:item.id,categoryId:category.id}];break;
   }
  }
  const {draft}=await editDocument(db,doc,edits,member.role);
  // Si con esta corrección el comprobante quedó completo, el bot lo registra solo.
  const auto=await tryAutoRegister(pool,db,doc,draft,{memberId:member.id,role:member.role},ctx);
  return say(auto??show(draft));
 }catch(error){
  if(error instanceof DocumentActionError||error instanceof ApiError)return say(error.message+' '+COMMAND_HELP);
  throw error;
 }
}
