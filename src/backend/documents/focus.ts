import type {Pool} from 'pg';
import type {Connection} from '../expenses/repository';
import {trace} from '../shared/trace';
import {ApiError} from '../shared/errors';
import {normalizeName,paymentEvidence} from '../whatsapp/candidate';
import {conversationTtlMinutes} from '../whatsapp/config';
import {closeConversation,findActiveConversation} from '../whatsapp/conversation';
import {findCategory,parseAmountText,parseDateText} from './commands';
import type {Edit,DraftContext} from './draft';
import {toCents,includedItems} from './reconcile';
import {COMMAND_HELP,receiptSummary} from './summary';
import type {ReceiptDraft} from './types';
import {InterpretationError} from '../whatsapp/candidate';
import type {TurnInterpreter,TurnProposal} from './turn';
import {forgetRule,listRules} from './rules';
import {cancelDocument,confirmDocument,DocumentActionError,editDocument,loadContext,tryAutoRegister,type DocRow} from './service';

// Árbitro de contexto: decide qué tarea abierta del integrante recibe un mensaje que no es un comando exacto. Ordena la respuesta
// como pide el diseño: recuperación/cancelación primero, después respuesta a la tarea enfocada (el comprobante abierto), y recién al
// final el flujo de gasto nuevo. Todo se resuelve por reglas; ningún mensaje de datos abre un gasto mientras un comprobante espera ese dato.
type Reply={outcome:'document_command';reply:string};
const say=(reply:string):Reply=>({outcome:'document_command',reply});
const flat=(t:string)=>normalizeName(t).replace(/[.,;:!¡?¿"'«»]/g,' ').replace(/\s+/g,' ').trim();

export type Recovery='pending'|'cancelAll'|'backToTicket'|'dropExpense';
export function parseRecovery(text:string):Recovery|null{
 const t=flat(text);
 if(/^(?:que|cuales?) (?:tengo|hay|me queda|me quedan|quedo) pendientes?(?: .*)?$|^pendientes?$|^que me falta(?: .*)?$|^en que estabamos$/.test(t))return 'pending';
 if(/^(?:cancela|cancelar|cancelo|descarta|descartar|borra|borrar) (?:todo|todos|todo lo pendiente|lo pendiente|todos los pendientes)$|^(?:empezar|empezamos|empeza|arrancar|arrancamos) de (?:nuevo|cero)$/.test(t))return 'cancelAll';
 if(/^(?:volvamos|volvemos|volve|volver|retomemos|retomar|segui|seguimos|seguir) (?:al|a el|con el|con la|a la) (?:ticket|comprobante|foto|recibo|pago)(?: anterior)?$/.test(t))return 'backToTicket';
 if(/^(?:ese|este|el) gasto no$|^no (?:era|es) (?:un )?gasto nuevo$|^me equivoque$|^me confundi$|^ignora (?:ese|el) gasto$/.test(t))return 'dropExpense';
 return null;
}

// Reglas de categoría aprendidas: «mis reglas» las lista y «olvidá la regla de X» borra una (el administrador, también las de la familia).
export type RulesCommand={type:'list'}|{type:'forget';name:string};
export function parseRulesCommand(text:string):RulesCommand|null{
 const t=flat(text);let m:RegExpExecArray|null;
 if(/^(?:mis )?reglas(?: de categorias?)?$|^que aprendiste$|^que recordas de (?:las )?categorias$/.test(t))return {type:'list'};
 if((m=/^(?:olvida|olvidate|borra|borrar|elimina|eliminar)(?: la)? regla (?:de |del )?(.+)$/.exec(t)))return {type:'forget',name:m[1]};
 return null;
}
export const isFocusCommand=(text:string)=>parseRecovery(text)!==null||parseRulesCommand(text)!==null;
const OPEN_RECEIPT="SELECT * FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state='needs_review' AND kind IN ('purchase_receipt','payment_receipt') AND draft IS NOT NULL ORDER BY created_at";
export const hasOpenReceipt=async(pool:Pool,family:string,memberId:string)=>(await pool.query(OPEN_RECEIPT+' LIMIT 1',[family,memberId])).rowCount!>0;
const asReceipt=(d:DocRow['draft']):ReceiptDraft|null=>d&&(d.kind==='purchase_receipt'||d.kind==='payment_receipt')?d:null;
const money=(d:ReceiptDraft)=>(d.total?' por '+d.total.replace(/\.00$/,'')+' '+d.currency:'');
const label=(d:DocRow)=>{const r=asReceipt(d.draft);return r?r.description+money(r)+' (código '+d.short_code+')':'un archivo (código '+d.short_code+')';};

const CONFIRM='confirmar|confirma|confirmalo|confirmala|confirmo|confirmado|registrar|registralo|registrala|guardar|guardalo|guardala|aceptar|dale|ok|listo|si';
const LEAD=new RegExp('^(?:'+CONFIRM+')\\b[\\s,.;:-]*');
const TAIL=new RegExp('(?:^|[\\s,.;:-]+(?:y |e )?)(?:'+CONFIRM+')[\\s,.;:!-]*$');
const FILLER=/^(?:(?:y|e|fue|es|son|era|va|van|ponelo|ponela|pone|para|en|de|del|con|a|como|la|el|lo|los|las|pague|pagado|pagada|gasto|categoria) )+/;
const AMOUNT='\\$?\\s*[\\d.,]+(?:\\s*(?:mil|k|lucas|pesos))?';

// Divide un mensaje con varios datos («Supermercado, efectivo y confirmar») en ediciones. Todo o nada: si una parte no se entiende,
// no se aplica ninguna (devuelve null) y el mensaje no se interpreta a medias.
// Ningún renglón tiene categoría (o todos): la respuesta es para el ticket entero. Si se separó alguno, es para el que falta.
function categoryEdit(draft:ReceiptDraft,categoryId:string):Edit{
 const all=includedItems(draft).filter(i=>!i.adjustment),lacking=all.filter(i=>!i.categoryId);
 return !lacking.length||lacking.length===all.length?{type:'ticketCategory',categoryId}:{type:'itemCategory',itemId:lacking[0].id,categoryId};
}
const CONFIRM_WORDS=new RegExp('(?:^|[^a-z])(?:'+CONFIRM+'|cargalo|cargala|anotalo|anotala)(?:$|[^a-z])');
// Valida lo que propuso Gemini con las mismas reglas que el camino por reglas. Cualquier dato que no se pueda comprobar anula todo.
export function planFromTurn(draft:ReceiptDraft,text:string,p:TurnProposal,ctx:DraftContext):{edits:Edit[];confirm:boolean;cancel:boolean}|null{
 if(!p.relatedToReceipt)return null;
 const said=normalizeName(text),edits:Edit[]=[];
 if(p.category){const c=findCategory(ctx.categories,p.category);if(!c)return null;edits.push(categoryEdit(draft,c.id));}
 if(p.paymentMethod)edits.push({type:'paymentMethod',value:p.paymentMethod});
 if(p.scope)edits.push({type:'scope',value:p.scope});
 if(p.dateText){const v=parseDateText(p.dateText,ctx.today);if(!v)return null;edits.push({type:'date',value:v});}
 if(p.totalText){const v=parseAmountText(p.totalText);if(!v)return null;edits.push({type:'total',value:v});}
 // Registrar o descartar exige palabras del propio mensaje: el modelo no puede decidirlo solo.
 const confirm=p.confirm&&CONFIRM_WORDS.test(said),cancel=p.cancel&&/descart|cancel|borr|anul/.test(said)&&!edits.length;
 if(cancel)return {edits,confirm:false,cancel:true};
 return edits.length||confirm?{edits,confirm,cancel:false}:null;
}
export function planCompound(draft:ReceiptDraft,text:string,ctx:DraftContext):{edits:Edit[];confirm:boolean}|null{
 let rest=normalizeName(text).replace(/[¡!¿?"'«»]/g,''),confirm=false;
 for(let n=0;n<2;n++){
  if(LEAD.test(rest)){rest=rest.replace(LEAD,'');confirm=true;}
  if(TAIL.test(rest)){rest=rest.replace(TAIL,'');confirm=true;}
 }
 rest=rest.replace(/[\s,.;:-]+$/,'').trim();
 if(!rest)return null;
 const noTotal=draft.total===null||toCents(draft.total)<=0;
 const correction=new RegExp('^(?:no,? )?(?:fueron|fue|son|es|era|eran|total)\\s+('+AMOUNT+')(?:,?\\s+no\\s+.+)?$').exec(rest);
 if(correction){const v=parseAmountText(correction[1].replace(/[\s.,]+$/,''));return v?{edits:[{type:'total',value:v}],confirm}:null;}
 const one=(part:string):Edit|null=>{
  const s=part.replace(/[.,;:]+$/,'').trim().replace(FILLER,'').trim();
  if(!s)return null;
  if(/^(?:hoy|ayer|anteayer)$|^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(s)){const v=parseDateText(s,ctx.today);return v?{type:'date',value:v}:null;}
  if(/^(?:efectivo|debito|credito|transferencia|billetera|mercado pago)$/.test(s)){const v=paymentEvidence(s);return v?{type:'paymentMethod',value:v}:null;}
  if(/^(?:casa|hogar|familia|familiar)$/.test(s))return {type:'scope',value:'household'};
  if(/^(?:personal|mio|mia|propio)$/.test(s))return {type:'scope',value:'personal'};
  // «2» / «la 2» / «opción 2»: una de las categorías que el bot ofreció.
  const pick=/^(?:opcion |numero )?([1-3])$/.exec(s);
  if(pick&&!noTotal){const id=draft.suggestions?.[Number(pick[1])-1];return id&&ctx.categories.some(c=>c.id===id&&c.active)?categoryEdit(draft,id):null;}
  if(noTotal&&new RegExp('^'+AMOUNT+'$').test(s)){const v=parseAmountText(s);return v?{type:'total',value:v}:null;}
  const c=findCategory(ctx.categories,s);
  if(!c)return null;
  return categoryEdit(draft,c.id);
 };
 const whole=one(rest),edits:Edit[]=[];
 if(whole)edits.push(whole);
 else for(const part of rest.split(/\s*[,;]\s*|\s*\.\s+|\s+(?:y|e)\s+/).filter(Boolean)){
  const e=one(part);if(!e)return null;edits.push(e);
 }
 // Dos datos del mismo tipo en un mensaje se contradicen: se pregunta en vez de elegir uno.
 const kinds=edits.map(e=>e.type);
 return new Set(kinds).size===kinds.length&&edits.length?{edits,confirm}:null;
}

type Member={id:string;role:'admin'|'member'};
async function recover(pool:Pool,db:Connection,member:Member,family:string,kind:Recovery):Promise<Reply|null>{
 const conv=await findActiveConversation(db,family,member.id,true);
 const docs:DocRow[]=(await db.query("SELECT * FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state IN ('received','processing','needs_review') ORDER BY created_at FOR UPDATE",[family,member.id])).rows;
 const admin=(await db.query("SELECT id FROM appgastos.admin_actions WHERE family_id=$1 AND member_id=$2 AND state='pending' FOR UPDATE",[family,member.id])).rows;
 const receipts=docs.filter(d=>d.state==='needs_review'&&asReceipt(d.draft));
 const openLine=receipts.length===1?'\nSeguimos con '+label(receipts[0])+'. Decime la categoría, cómo pagaste o «confirmar».':'';
 if(kind==='pending'){
  const lines=[...(conv?['• Un gasto que estabas cargando («ese gasto no» lo descarta).']:[]),...docs.map(d=>'• Comprobante: '+label(d)+'.'),...(admin.length?['• Un cambio de configuración esperando tu confirmación.']:[])];
  return say(lines.length?'Tenés pendiente:\n'+lines.join('\n')+'\nPodés decir «cancelá todo» para descartarlos.':'No tenés nada pendiente.');
 }
 if(kind==='dropExpense'){
  if(!conv)return null;
  await closeConversation(db,conv.id,'cancelled');
  return say('Listo, descarté ese gasto. No registré nada.'+openLine);
 }
 if(kind==='backToTicket'){
  if(!receipts.length)return say('No tengo ningún comprobante abierto. Mandame la foto de nuevo.');
  if(receipts.length>1)return say('Tenés varios comprobantes abiertos: '+receipts.map(label).join('; ')+'. Indicá el código, por ejemplo «confirmar '+receipts[0].short_code+'».');
  if(conv)await closeConversation(db,conv.id,'cancelled');
  return say('Dale, volvemos a '+label(receipts[0])+'. Decime la categoría, cómo pagaste o «confirmar».');
 }
 // cancelAll: lo pendiente se descarta; lo ya registrado no se toca nunca.
 if(!conv&&!docs.length&&!admin.length)return say('No tenés nada pendiente para cancelar.');
 if(conv)await closeConversation(db,conv.id,'cancelled');
 for(const d of docs)await cancelDocument(db,d).catch(e=>{if(!(e instanceof DocumentActionError))throw e;});
 if(admin.length)await db.query("UPDATE appgastos.admin_actions SET state='cancelled' WHERE family_id=$1 AND member_id=$2 AND state='pending'",[family,member.id]);
 return say('Listo, cancelé todo lo pendiente ('+[conv?'gasto en curso':'',docs.length?docs.length+' comprobante'+(docs.length>1?'s':''):'',admin.length?'cambio de configuración':''].filter(Boolean).join(', ')+'). Lo que ya estaba registrado no se toca.');
}

async function traced(route:string,r:Reply|null,extra:Record<string,string|number|boolean|null|string[]>={}):Promise<Reply|null>{trace('bot_focus',{route,handled:r!==null,...extra});return r;}
export async function focusedReply(pool:Pool,db:Connection,member:Member,family:string,text:string,hasConversation:boolean,turn?:TurnInterpreter|null):Promise<Reply|null>{
 const rules=parseRulesCommand(text);
 if(rules){
  const ctx=await loadContext(db,family);
  return traced('rules',say(rules.type==='list'?await listRules(db,family,member,ctx):await forgetRule(db,family,member,rules.name)),{cmd:rules.type});
 }
 const recovery=parseRecovery(text);
 if(recovery)return traced('recovery',await recover(pool,db,member,family,recovery),{cmd:recovery});
 // Con un gasto en curso las respuestas son de ese gasto; para salir están «ese gasto no», «volvamos al ticket» y «cancelá todo».
 if(hasConversation)return null;
 const open:DocRow[]=(await db.query(OPEN_RECEIPT+' FOR UPDATE',[family,member.id])).rows;
 const doc=open[0],draft=asReceipt(doc?.draft??null);
 // Varios comprobantes abiertos: un mensaje con datos no se aplica a ninguno por su cuenta; se pide el código.
 if(open.length>1&&draft&&(planCompound(draft,text,await loadContext(db,family))||flat(text).split(' ').length<=3&&!/\d/.test(flat(text))))
  return traced('multiple_open',say('Tenés varios comprobantes abiertos: '+open.map(label).join('; ')+'. Indicá el código, por ejemplo «confirmar '+open[0].short_code+'», o decí «cancelá todo».'),{open:open.length}) as Promise<Reply>;
 if(open.length!==1||!draft||Date.now()-new Date(doc.updated_at).getTime()>conversationTtlMinutes()*60000)return null;
 const ctx=await loadContext(db,family);
 // «Otra»: se muestran todas las categorías (la lista larga solo aparece cuando el usuario la pide).
 if(/^otra(?: categoria)?$/.test(flat(text)))return say('Tus categorías: '+ctx.categories.filter(c=>c.active).map(c=>c.name).join(', ')+'. ¿Cuál va?');
 let plan:{edits:Edit[];confirm:boolean;cancel?:boolean}|null=planCompound(draft,text,ctx);
 // Las reglas no entendieron: una sola consulta a Gemini (sin reintentos). Si falla o no es para el comprobante, sigue el camino normal.
 const t0=flat(text);
 if(!plan&&turn&&t0.split(' ').length>=2&&!(/\d/.test(t0)&&/^(?:gast|compr|pag|cobr|puse|carg|sali)/.test(t0))){
  try{plan=planFromTurn(draft,text,await turn({text:text.slice(0,500),hoy:ctx.today,categorias:ctx.categories.filter(c=>c.active).map(c=>c.name),comprobante:{comercio:draft.description,total:draft.total}}),ctx);}
  catch(error){if(!(error instanceof InterpretationError))throw error;}
 }
 trace('bot_focus',{route:plan?(plan.edits.length||plan.confirm?'compound':'cancel'):'unmatched',handled:plan!==null,edits:plan?.edits.map(e=>e.type)??[],confirm:plan?.confirm??false});
 if(plan?.cancel)return say(await cancelDocument(db,doc));
 if(!plan){
  // Una frase corta sin importe ni verbo de gasto, con un comprobante esperando, casi seguro es para el comprobante: no se abre un gasto nuevo.
  const t=flat(text);
  if(t.split(' ').length<=3&&!/\d/.test(t)&&!/^(?:gast|compr|pag|cobr|puse|carg|sali)/.test(t))
   return (trace('bot_focus',{route:'trap_guard',handled:true}),say('Tengo abierto '+label(doc)+' y no entendí si tu mensaje es para ese. Decime la categoría, cómo pagaste o «cancelar». Para un gasto nuevo escribí el importe, por ejemplo «gasté 5000 en kiosco».'));
  return null;
 }
 try{
  const edited=await editDocument(db,doc,plan.edits,member.role),viewer={memberId:member.id,role:member.role};
  if(!plan.confirm){
   const auto=await tryAutoRegister(pool,db,doc,edited.draft,viewer,ctx);
   return say(auto??receiptSummary(edited.draft as ReceiptDraft,ctx,doc.short_code));
  }
  // Se confirma recién con las ediciones aplicadas; si todavía falta un dato se pregunta (los datos válidos ya quedaron cargados).
  try{return say(await confirmDocument(pool,db,{...doc,draft:edited.draft},viewer));}
  catch(error){if(error instanceof DocumentActionError)return say(receiptSummary(edited.draft as ReceiptDraft,ctx,doc.short_code));throw error;}
 }catch(error){
  if(error instanceof DocumentActionError||error instanceof ApiError)return say(error.message+' '+COMMAND_HELP);
  throw error;
 }
}
