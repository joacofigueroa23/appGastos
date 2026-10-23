import type {Pool} from 'pg';
import {randomInt} from 'node:crypto';
import {PAYMENT_CODES,type PaymentCode} from '../../shared/apiTypes';
import {ApiError} from '../shared/errors';
import {categoryService} from '../categories/service';
import {budgetService} from '../budgets/service';
import {fixedService,generateOccurrences} from '../fixed/service';
import {payOccurrence} from '../fixed/pay';
import type {Connection} from '../expenses/repository';
import {normalizeName,normalizeTextAmount,referenceDate,resolveDate} from './candidate';
import {isDateOnly} from '../../utils/finance';
import {effectiveBudgets} from '../budgets/service';
import {formatAmount} from './replies';
import {addMonths,parseMonthText,upcomingMonth,type AdminIntent,type MonthRef} from './adminIntent';
import {parseCommand} from '../documents/commands';
// Administración conversacional. Cada pedido del administrador se interpreta (Gemini), el backend lo valida y lo guarda como una acción
// PENDIENTE con un código; recién al confirmar se ejecuta, con los mismos servicios (y reglas) que usa la web. Nada se ejecuta por lo que
// diga el modelo. La identidad y el rol salen del número vinculado, nunca del mensaje.
// Si falta un dato, el pedido queda "juntando datos" (type collecting): el bot pregunta, recuerda lo ya dicho y la próxima respuesta lo completa.
export interface BulkBudgetItem {name:string;amount:string;categoryId:string|null;categoryName:string|null;current?:string|null}
export interface BulkFixedItem {name:string;amount:string;dueDay:number|null;categoryId:string|null;categoryName:string|null;exists?:boolean}
export type StoredAction=
 |{type:'collecting';intent:AdminIntent;asking:AskField;question:string}
 |{type:'create_category';name:string;parentId:string|null;parentName:string|null}
 |{type:'set_budget';categoryId:string;categoryName:string;amount:string;from:string}
 |{type:'set_budget_month';categoryId:string;categoryName:string;amount:string;month:string}
 |{type:'create_fixed';name:string;amount:string;dueDay:number;categoryId:string|null;categoryName:string|null;startMonth:string}
 |{type:'set_fixed_amount';fixedId:string;fixedName:string;amount:string;from:string}
 |{type:'set_fixed_active';fixedId:string;fixedName:string;active:boolean}
 |{type:'pay_fixed';occurrenceId:string;fixedName:string;period:string;amount:string;paymentMethod:PaymentCode|null;date?:string|null}
 |{type:'bulk_budget';items:BulkBudgetItem[];from:string;createMissing:boolean}
 |{type:'bulk_fixed';items:BulkFixedItem[];startMonth:string};
export type AskField='name'|'amount'|'dueDay'|'category'|'fixed'|'month'|'date';
const TTL_MINUTES=15;
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode=()=>Array.from({length:4},()=>CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const MONTH_NAMES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const monthLabel=(key:string)=>MONTH_NAMES[Number(key.slice(5,7))-1]+' de '+key.slice(0,4);
const PAYMENT_NAMES:Record<PaymentCode,string>={cash:'efectivo',debit_card:'débito',credit_card:'crédito',transfer:'transferencia',wallet:'billetera',other:'otro medio'};
const money=(v:string,fam:string)=>formatAmount(v.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''),fam,fam);
// Pregunta al usuario. Con `field` el pedido queda guardado esperando esa respuesta; sin `field` es una respuesta final (no se puede seguir).
class Ask extends Error {constructor(message:string,public field?:AskField){super(message);}}

interface Row {id:string;name:string;active:boolean;parent_id?:string|null}
const pick=(rows:Row[],ref:string|null,label:string,field:AskField='category'):Row|null=>{
 if(!ref)return null;
 const r=normalizeName(ref),active=rows.filter(x=>x.active),pool=active.length?active:rows;
 const exact=pool.filter(x=>normalizeName(x.name)===r);if(exact.length===1)return exact[0];
 const part=pool.filter(x=>normalizeName(x.name).includes(r)||r.includes(normalizeName(x.name)));
 if(part.length===1)return part[0];
 if(part.length>1)throw new Ask('Mmm, «'+ref+'» puede ser más de una de tus '+label+': '+part.slice(0,5).map(x=>x.name).join(', ')+'. ¿Cuál es?',field);
 return null;
};
const needAmount=(i:AdminIntent)=>{
 const parsed=i.amountText?normalizeTextAmount(i.amountText):null;
 if(!parsed||!i.amount||Number(parsed)!==Number(i.amount)||Number(parsed)<=0)throw new Ask('¿De cuánto es? Decímelo con el importe, por ejemplo «$500.000» o «500 mil».','amount');
 return parsed.includes('.')?parsed:parsed+'.00';
};

// ---- Respuesta corta a lo que se preguntó: reglas deterministas antes de consultar a Gemini.
// Fecha de un pago: «ayer», «el 8», «8/10», «8 de octubre». Nunca futura. null si no se entiende.
export function parsePaymentDate(raw:string,today:string):string|null{
 const t=normalizeName(raw).replace(/^(?:fue |lo pague |pague |pagado |el dia |el |dia )+/,'').trim();
 const day=/^(\d{1,2})$/.exec(t);
 const date=day?today.slice(0,7)+'-'+day[1].padStart(2,'0'):resolveDate(t,today);
 return date&&isDateOnly(date)&&date<=today?date:null;
}
const dmy=(d:string)=>d.slice(8)+'/'+d.slice(5,7)+'/'+d.slice(0,4);
export function answerToAsk(asking:AskField,text:string,categories:Row[],today=referenceDate(new Date())):Partial<AdminIntent>|null{
 const t=text.trim();
 if(!t||t.split(/\s+/).length>5)return null;
 if(asking==='date')return parsePaymentDate(t,today)?{dateText:t}:null;
 if(asking==='dueDay'){const m=/\b(3[01]|[12]\d|[1-9])\b/.exec(normalizeName(t));return m?{dueDay:Number(m[1])}:null;}
 if(asking==='amount'){const a=normalizeTextAmount(t);return a?{amount:a,amountText:t}:null;}
 if(asking==='month'){return parseMonthText(t)?{monthText:t}:null;}
 if(asking==='category'){
  const c=pick(categories,t.replace(/^\s*(?:en la |en el |a la |al |la |el |de |para |categor[ií]a )+/i,'').trim(),'categorías');
  return c?{category:c.name}:null;
 }
 if(asking==='fixed'||asking==='name')return {[asking==='fixed'?'fixed':'name']:t.replace(/^\s*(?:se llama |el |la )+/i,'').trim().slice(0,120)};
 return null;
}
// Une lo nuevo con lo que ya se había dicho: lo presente en el mensaje nuevo pisa lo anterior; un pedido distinto lo reemplaza.
export function mergeIntent(base:AdminIntent,patch:Partial<AdminIntent>):AdminIntent{
 // Otro pedido distinto: arranca de cero (no hereda datos del anterior).
 if(patch.action&&patch.action!=='none'&&patch.action!==base.action)return patch as AdminIntent;
 const out={...base} as Record<string,unknown>;
 for(const [k,v] of Object.entries(patch))if(k!=='action'&&v!==null&&v!==undefined)out[k]=v;
 return out as unknown as AdminIntent;
}

// ---- Preparación: valida y deja la acción pendiente (o juntando datos). No cambia ninguna configuración.
export async function prepareAdminAction(db:Connection,family:string,member:{id:string},intent:AdminIntent,at:Date,familyCurrency:string,opts:{prefix?:string}={}):Promise<{outcome:'admin_config';reply:string}|null>{
 if(intent.action==='none')return null;
 const today=referenceDate(at),cur=today.slice(0,7);
 const categories=(await db.query('SELECT id,name,active,parent_id FROM appgastos.categories WHERE family_id=$1',[family])).rows as Row[];
 const fixedRows=(await db.query('SELECT id,name,active FROM appgastos.fixed_expenses WHERE family_id=$1',[family])).rows as Row[];
 let action:StoredAction;
 try{
  const listCats=()=>categories.filter(x=>x.active).map(x=>x.name).join(', ');
  const category=()=>{const c=pick(categories,intent.category,'categorías');if(!c)throw new Ask('No encontré esa categoría entre las tuyas ('+listCats()+'). ¿Cuál querés usar?','category');return c;};
  const fixed=()=>{const f=pick(fixedRows,intent.fixed,'obligaciones','fixed');if(!f)throw new Ask('No encontré ese gasto fijo. Tenés: '+(fixedRows.map(x=>x.name).join(', ')||'ninguno')+'. ¿Cuál es?','fixed');return f;};
  const monthRef=parseMonthText(intent.monthText);
  const from=(ref:MonthRef|null)=>ref?upcomingMonth(ref,today):cur;
  switch(intent.action){
   case 'create_category':{
    if(!intent.name)throw new Ask('Dale, ¿cómo se llama la categoría?','name');
    if(categories.some(c=>normalizeName(c.name)===normalizeName(intent.name!)))throw new Ask('Ya tenés una categoría llamada «'+intent.name+'», no hace falta crearla.');
    const parent=intent.parent?pick(categories,intent.parent,'categorías'):null;
    if(intent.parent&&!parent)throw new Ask('No encontré la categoría principal «'+intent.parent+'». Tus principales: '+categories.filter(x=>!x.parent_id&&x.active).map(x=>x.name).join(', ')+'.');
    if(parent?.parent_id)throw new Ask('«'+parent.name+'» ya es una subcategoría y solo hay dos niveles. ¿La pongo dentro de «'+(categories.find(c=>c.id===parent.parent_id)?.name??'su principal')+'»?');
    action={type:'create_category',name:intent.name,parentId:parent?.id??null,parentName:parent?.name??null};break;
   }
   case 'set_budget':{const c=category();action={type:'set_budget',categoryId:c.id,categoryName:c.name,amount:needAmount(intent),from:from(monthRef)};break;}
   case 'set_budget_month':{
    const c=category();if(!monthRef)throw new Ask('¿Para qué mes es esa excepción? Por ejemplo «diciembre».','month');
    action={type:'set_budget_month',categoryId:c.id,categoryName:c.name,amount:needAmount(intent),month:upcomingMonth(monthRef,today)};break;
   }
   case 'create_fixed':{
    if(!intent.name)throw new Ask('Dale, ¿cómo se llama el gasto fijo?','name');
    if(fixedRows.some(f=>normalizeName(f.name)===normalizeName(intent.name!)))throw new Ask('Ya tenés un gasto fijo llamado «'+intent.name+'». Si querés cambiarle el importe, decime «cambiá '+intent.name+' a $X».');
    const amount=needAmount(intent);
    if(!intent.dueDay)throw new Ask('Perfecto, «'+intent.name+'» de '+money(amount,familyCurrency)+'. ¿Qué día del mes vence?','dueDay');
    // Si no dijo la categoría, se intenta con el nombre del gasto («impuestos» → «Impuestos & Seguros»); si no se parece a una sola, se le pregunta.
    let c:Row|null=null;
    try{c=intent.category?category():pick(categories,intent.name,'categorías');}catch(e){if(intent.category)throw e;c=null;}
    action={type:'create_fixed',name:intent.name,amount,dueDay:intent.dueDay,categoryId:c?.id??null,categoryName:c?.name??null,startMonth:cur};break;
   }
   case 'set_fixed_amount':{const f=fixed();action={type:'set_fixed_amount',fixedId:f.id,fixedName:f.name,amount:needAmount(intent),from:from(monthRef)};break;}
   case 'set_fixed_active':{
    const f=fixed();if(intent.active===null)throw new Ask('¿Querés activar o desactivar «'+f.name+'»?');
    action={type:'set_fixed_active',fixedId:f.id,fixedName:f.name,active:intent.active};break;
   }
   case 'pay_fixed':{
    const f=fixed();
    // Las obligaciones de los próximos 12 meses se generan (idempotente) para poder pagar por adelantado.
    await generateOccurrences(db,family,'0001-01',addMonths(cur,12));
    const all=(await db.query(`SELECT o.id,to_char(o.period,'YYYY-MM') AS period,o.expected_amount::text AS amount,(o.expense_id IS NOT NULL) AS paid FROM appgastos.fixed_expense_occurrences o
     WHERE o.family_id=$1 AND o.fixed_expense_id=$2 ORDER BY o.period`,[family,f.id])).rows as {id:string;period:string;amount:string;paid:boolean}[];
    let candidates:typeof all,alreadyPaid=false;
    if(monthRef){
     const sameMonth=all.filter(o=>monthRef.month?Number(o.period.slice(5,7))===monthRef.month&&(!monthRef.year||Number(o.period.slice(0,4))===monthRef.year):o.period===upcomingMonth(monthRef,today));
     // Sin año, manda lo pasado o actual (si todas figuran pagadas, se avisa); solo si ese mes todavía no empezó se toma el próximo.
     const past=monthRef.year||!monthRef.month?sameMonth:sameMonth.filter(o=>o.period<=cur);
     const scope=past.length?past:sameMonth.filter(o=>!o.paid).slice(0,1);
     candidates=scope.filter(o=>!o.paid);alreadyPaid=!candidates.length&&scope.some(o=>o.paid);
    }else candidates=all.filter(o=>!o.paid&&o.period<=cur);
    if(!candidates.length)throw new Ask(alreadyPaid?'«'+f.name+'» ya figura como pagado en ese mes, así que no registré nada.':'No encontré una obligación pendiente de «'+f.name+'»'+(monthRef?' para ese mes':'')+'.');
    if(candidates.length>1)throw new Ask('«'+f.name+'» tiene varias pendientes: '+candidates.slice(0,6).map(o=>monthLabel(o.period)).join(', ')+'. ¿De qué mes es el pago?','month');
    const o=candidates[0],amount=intent.amountText?needAmount(intent):o.amount;
    // Fecha efectiva del pago: la que diga el usuario (nunca futura); si no dice ninguna, hoy.
    let date:string|null=null;
    if(intent.dateText){date=parsePaymentDate(intent.dateText,today);if(!date)throw new Ask('No pude entender esa fecha de pago (o todavía no pasó). ¿Qué día fue? Por ejemplo «ayer» o «8/10».','date');}
    action={type:'pay_fixed',occurrenceId:o.id,fixedName:f.name,period:o.period,amount,paymentMethod:intent.paymentMethod,date};break;
   }
  }
 }catch(error){
  if(!(error instanceof Ask))throw error;
  // Con campo: queda guardado para completarlo con la próxima respuesta. Sin campo: respuesta final.
  if(error.field)return store(db,family,member.id,{type:'collecting',intent,asking:error.field,question:error.message},at,familyCurrency,error.message,opts.prefix);
  return {outcome:'admin_config',reply:error.message};
 }
 return store(db,family,member.id,action,at,familyCurrency,undefined,opts.prefix);
}

// ---- Listas (fotos de presupuestos o de gastos fijos): se arma UNA acción con todas las líneas y se confirma una vez.
export async function prepareBulkAction(db:Connection,family:string,member:{id:string},list:{kind:'budget'|'fixed';items:{name:string;amount:string|null;dueDay:number|null;category:string|null}[]},at:Date,fam:string):Promise<{outcome:'admin_config';reply:string}>{
 const cur=referenceDate(at).slice(0,7);
 const categories=(await db.query('SELECT id,name,active,parent_id FROM appgastos.categories WHERE family_id=$1',[family])).rows as Row[];
 const safePick=(ref:string|null)=>{try{return pick(categories,ref,'categorías');}catch{return null;}};
 const seen=new Set<string>();
 const items=list.items.filter(i=>i.name&&i.amount&&Number(i.amount)>0).filter(i=>{const k=normalizeName(i.name);if(seen.has(k))return false;seen.add(k);return true;}).slice(0,40);
 if(!items.length)return {outcome:'admin_config',reply:'Vi una lista pero no pude leer importes claros. ¿Me la mandás de nuevo con una foto más nítida o por texto?'};
 let action:StoredAction;
 const dec=(v:string)=>v.includes('.')?v:v+'.00';
 if(list.kind==='budget'){
  // Lo que ya está configurado se muestra con su valor actual: nada se pisa en silencio.
  const current=new Map((await effectiveBudgets(db,family,cur+'-01')).map(b=>[b.categoryId,b.amount]));
  action={type:'bulk_budget',from:cur,createMissing:false,items:items.map(i=>{const c=safePick(i.category||i.name);return {name:i.name,amount:dec(i.amount!),categoryId:c?.id??null,categoryName:c?.name??null,current:c?current.get(c.id)??null:null};})};
 }else{
  const existing=new Set((await db.query('SELECT name FROM appgastos.fixed_expenses WHERE family_id=$1',[family])).rows.map((r:{name:string})=>normalizeName(r.name)));
  action={type:'bulk_fixed',startMonth:cur,items:items.map(i=>{const c=safePick(i.category||i.name);return {name:i.name,amount:dec(i.amount!),dueDay:i.dueDay,categoryId:c?.id??null,categoryName:c?.name??null,exists:existing.has(normalizeName(i.name))};})};
 }
 return store(db,family,member.id,action,at,fam);
}

const missing=(a:StoredAction):'category'|'paymentMethod'|null=>a.type==='create_fixed'&&!a.categoryId?'category':a.type==='pay_fixed'&&!a.paymentMethod?'paymentMethod':null;
const lineBudget=(i:BulkBudgetItem,fam:string)=>'• '+i.name+(i.categoryName&&normalizeName(i.categoryName)!==normalizeName(i.name)?' → «'+i.categoryName+'»':'')+' — '+money(i.amount,fam)+(i.categoryId?(i.current?(Number(i.current)===Number(i.amount)?' (sin cambios)':' (ya tenías '+money(i.current,fam)+')'):''):' ⚠️ no encontré esa categoría');
const lineFixed=(i:BulkFixedItem,fam:string)=>{
 if(i.exists)return '• '+i.name+' — '+money(i.amount,fam)+' ⚠️ ya existe: la dejo como está (para cambiarle el importe decime «cambiá '+i.name+' a $X»)';
 const problems=[!i.dueDay?'falta el día de vencimiento':'',!i.categoryId?'falta la categoría':''].filter(Boolean);
 return '• '+i.name+' — '+money(i.amount,fam)+(i.dueDay?', vence el '+i.dueDay:'')+(i.categoryName?' ('+i.categoryName+')':'')+(problems.length?' ⚠️ '+problems.join(' y ')+': la dejo afuera':'');
};
export function describe(a:StoredAction,fam:string):string{
 switch(a.type){
  case 'collecting':return 'completar un pedido';
  case 'create_category':return a.parentName?'crear la subcategoría «'+a.name+'» dentro de «'+a.parentName+'»':'crear la categoría «'+a.name+'»';
  case 'set_budget':return 'fijar el presupuesto mensual de «'+a.categoryName+'» en '+money(a.amount,fam)+' desde '+monthLabel(a.from)+' (se renueva solo cada mes; no cambia los meses anteriores)';
  case 'set_budget_month':return 'usar '+money(a.amount,fam)+' de presupuesto para «'+a.categoryName+'» solo en '+monthLabel(a.month)+' (el presupuesto base no cambia)';
  case 'create_fixed':return 'agregar el gasto fijo «'+a.name+'» de '+money(a.amount,fam)+', vence el día '+a.dueDay+(a.categoryName?', categoría «'+a.categoryName+'»':'');
  case 'set_fixed_amount':return 'cambiar el importe de «'+a.fixedName+'» a '+money(a.amount,fam)+' desde '+monthLabel(a.from)+' (lo ya pagado y los meses anteriores no cambian)';
  case 'set_fixed_active':return (a.active?'reactivar':'desactivar')+' el gasto fijo «'+a.fixedName+'»'+(a.active?'':' (deja de generar obligaciones nuevas; las pagadas se conservan)');
  case 'pay_fixed':return 'registrar el pago de «'+a.fixedName+'» de '+monthLabel(a.period)+' por '+money(a.amount,fam)+(a.paymentMethod?' con '+PAYMENT_NAMES[a.paymentMethod]:'')+(a.date?', pagado el '+dmy(a.date):'')+'. Se registra UN solo gasto de la casa y la obligación queda pagada';
  case 'bulk_budget':return 'fijar estos presupuestos mensuales desde '+monthLabel(a.from)+':\n'+a.items.slice(0,15).map(i=>lineBudget(i,fam)).join('\n')+(a.items.length>15?'\n… y '+(a.items.length-15)+' más':'');
  case 'bulk_fixed':return 'agregar estos gastos fijos:\n'+a.items.slice(0,15).map(i=>lineFixed(i,fam)).join('\n')+(a.items.length>15?'\n… y '+(a.items.length-15)+' más':'');
 }
}
async function store(db:Connection,family:string,memberId:string,action:StoredAction,at:Date,fam:string,question?:string,prefix?:string){
 const docCodes=new Set((await db.query("SELECT short_code FROM appgastos.documents WHERE family_id=$1 AND state IN ('received','processing','needs_review')",[family])).rows.map((r:{short_code:string})=>r.short_code));
 const summary=describe(action,fam);
 const replaced=(await db.query("UPDATE appgastos.admin_actions SET state='cancelled' WHERE family_id=$1 AND member_id=$2 AND state='pending' RETURNING id,action",[family,memberId])).rows as {action:StoredAction}[];
 // Seguir completando el mismo pedido no es "reemplazar": solo se avisa cuando se descartó uno que ya estaba listo para confirmar.
 const replacedReady=replaced.some(r=>r.action.type!=='collecting')&&action.type!=='collecting';
 let code=newCode();while(docCodes.has(code))code=newCode();
 for(let attempt=0;attempt<6;attempt++){
  const r=await db.query(`INSERT INTO appgastos.admin_actions(family_id,member_id,short_code,action,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[family,memberId,code,JSON.stringify(action),summary,new Date(at.getTime()+TTL_MINUTES*60000)]);
  if(r.rowCount)return {outcome:'admin_config' as const,reply:(prefix?prefix+'\n':'')+(action.type==='collecting'?(question||'¿Me contás un poco más?')+'\n(Si te equivocaste, escribí *cancelar*.)':prompt(action,summary,code,replacedReady&&!prefix))};
  code=newCode();
 }
 return {outcome:'admin_config' as const,reply:'No pude preparar la acción ahora. Probá de nuevo en un momento.'};
}
const prompt=(a:StoredAction,summary:string,code:string,replaced:boolean)=>{
 const need=missing(a);
 const bulkNotes=a.type==='bulk_budget'&&a.items.some(i=>!i.categoryId)?'Las que no encontré las dejo afuera, o respondé *crear* y las creo como categorías nuevas. ':'';
 return (replaced?'(Dejé de lado tu pedido anterior sin aplicarlo.)\n':'')+'📝 Voy a '+summary+(a.type==='bulk_budget'||a.type==='bulk_fixed'?'\n':'.\n')+
  (need==='category'?'Antes decime en qué categoría lo ubico (por ejemplo «categoría Educación»). ':need==='paymentMethod'?'Antes decime con qué medio pagaste (efectivo, débito, crédito, transferencia o billetera). ':bulkNotes)+
  'Respondé *confirmar* para aplicarlo o *cancelar* para dejarlo. Código: '+code;
};

// ---- Respuesta del administrador a una acción pendiente (confirmar, cancelar, completar un dato). Devuelve null si el mensaje no es para ella.
// Con una conversación de gasto o un comprobante más nuevo abierto, "sí/ok" sin código es de esos y no de la acción.
export async function adminCommand(pool:Pool,db:Connection,member:{id:string;role:'admin'|'member'},family:string,text:string,hasConversation:boolean,at:Date,familyCurrency:string):Promise<{outcome:'admin_config';reply:string}|null>{
 const cmd=parseCommand(text);
 const pending=(await db.query("SELECT * FROM appgastos.admin_actions WHERE family_id=$1 AND member_id=$2 AND state='pending' FOR UPDATE",[family,member.id])).rows[0] as {id:string;short_code:string;action:StoredAction;expires_at:Date;created_at:Date}|undefined;
 const say=(reply:string)=>({outcome:'admin_config' as const,reply});
 const code=cmd&&'code' in cmd&&cmd.code?cmd.code.toUpperCase():undefined;
 if(!pending){
  // Confirmar de nuevo algo ya aplicado (doble toque, reintento) no repite nada.
  if(cmd?.type==='confirm'&&code){
   const done=(await db.query("SELECT 1 FROM appgastos.admin_actions WHERE family_id=$1 AND member_id=$2 AND short_code=$3 AND state='confirmed' AND confirmed_at>now()-interval '1 day'",[family,member.id,code])).rowCount;
   if(done)return say('Esa acción ya estaba aplicada. No cambié nada de nuevo.');
  }
  return null;
 }
 if(member.role!=='admin')return say('Esa operación es solo para administradores.');
 const own=!!code&&code===pending.short_code;
 if(code&&!own)return null;
 if(!own){
  if(hasConversation)return null;
  const newer=(await db.query("SELECT 1 FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND state IN ('received','processing','needs_review') AND updated_at>$3 LIMIT 1",[family,member.id,pending.created_at])).rowCount;
  if(newer)return null;
 }
 if(new Date(pending.expires_at)<=at){
  await db.query("UPDATE appgastos.admin_actions SET state='expired' WHERE id=$1",[pending.id]);
  return cmd?say('Ese pedido venció (pasaron más de '+TTL_MINUTES+' minutos). Pedímelo de nuevo y lo preparo.'):null;
 }
 const action=pending.action,need=missing(action);
 const normalized=normalizeName(text).replace(/[.,;:!?¡¿"']/g,' ').replace(/\s+/g,' ').trim();
 const cancelWords=/^(?:cancelar|cancela|olvidalo|olvidate|dejalo|dejá|no|nada|anular)$/.test(normalized);
 if(cmd?.type==='cancel'||cancelWords){await db.query("UPDATE appgastos.admin_actions SET state='cancelled' WHERE id=$1",[pending.id]);return say('Listo, no hice ningún cambio. Cuando quieras, me lo volvés a pedir.');}
 // Juntando datos: la respuesta se resuelve afuera (puede necesitar a Gemini); acá solo se frena una confirmación prematura.
 if(action.type==='collecting')return cmd?.type==='confirm'?say('Todavía me falta un dato para armarlo. Contame lo que falta o escribí *cancelar*.'):null;
 const update=async(next:StoredAction)=>{
  await db.query('UPDATE appgastos.admin_actions SET action=$2,summary=$3,expires_at=$4 WHERE id=$1',[pending.id,JSON.stringify(next),describe(next,familyCurrency),new Date(at.getTime()+TTL_MINUTES*60000)]);
  return say(prompt(next,describe(next,familyCurrency),pending.short_code,false));
 };
 // "Crear" en una lista de presupuestos: también se crean las categorías que no existían.
 if(action.type==='bulk_budget'&&/^(?:crear|crealas|crearlas|si crealas|si crear|creala|crealo)$/.test(normalized))return update({...action,createMissing:true});
 // Lista pendiente: sacar una línea o corregir su importe, vencimiento o categoría.
 if(action.type==='bulk_budget'||action.type==='bulk_fixed'){
  const cats=(await db.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1',[family])).rows as Row[];
  const edit=editBulk(action,text,cats);
  if(edit&&'error' in edit)return say(edit.error);
  if(edit){
   if(!(edit.action as {items:unknown[]}).items.length){await db.query("UPDATE appgastos.admin_actions SET state='cancelled' WHERE id=$1",[pending.id]);return say('Saqué todas las líneas, así que no queda nada para aplicar.');}
   const r=await update(edit.action);return say(edit.note+'\n'+r.reply);
  }
 }
 // Completar el dato que falta.
 if(need==='paymentMethod'&&cmd?.type==='payment'&&action.type==='pay_fixed')return update({...action,paymentMethod:cmd.value});
 if(need==='category'&&action.type==='create_fixed'&&!cmd){
  const cats=(await db.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1',[family])).rows as Row[];
  let c:Row|null=null;
  try{c=pick(cats,text.replace(/^\s*(?:en la |en el |a la |al |la |el )?categor[ií]a\s+/i,'').trim(),'categorías');}catch{c=null;}
  if(c)return update({...action,categoryId:c.id,categoryName:c.name});
  return say('No encontré esa categoría. Tus categorías: '+cats.filter(x=>x.active).map(x=>x.name).join(', ')+'. ¿Cuál uso?');
 }
 if(need==='category'&&cmd?.type==='confirm')return say('Antes decime en qué categoría ubico «'+(action as {name:string}).name+'»: '+(await db.query('SELECT name FROM appgastos.categories WHERE family_id=$1 AND active ORDER BY name',[family])).rows.map((r:{name:string})=>r.name).join(', ')+'.');
 if(need==='paymentMethod'&&cmd?.type==='confirm')return say('Antes decime con qué medio pagaste: efectivo, débito, crédito, transferencia o billetera.');
 if(cmd?.type!=='confirm')return null;
 // Confirmar: se reclama la acción y se ejecuta en un SAVEPOINT; si falla, no queda nada a medias.
 await db.query('SAVEPOINT admin_action');
 try{
  await db.query("UPDATE appgastos.admin_actions SET state='confirmed',confirmed_at=now() WHERE id=$1",[pending.id]);
  const done=await execute(db,family,member.id,action,familyCurrency);
  await db.query('RELEASE SAVEPOINT admin_action');
  return say('✅ '+done);
 }catch(error){
  await db.query('ROLLBACK TO SAVEPOINT admin_action');
  if(!(error instanceof ApiError))throw error;
  await db.query("UPDATE appgastos.admin_actions SET state='cancelled',result=$2 WHERE id=$1",[pending.id,JSON.stringify({error:error.message})]);
  return say('No pude aplicarlo: '+error.message+' No cambié nada. Podés pedirlo de nuevo.');
 }
}

// ---- Ejecución: los mismos servicios que la web (permisos y reglas incluidos), dentro de la transacción del mensaje.
async function execute(db:Connection,family:string,memberId:string,a:StoredAction,fam:string):Promise<string>{
 const pool=db as unknown as Pool;
 switch(a.type){
  case 'collecting':throw new ApiError(400,'Falta completar el pedido.');
  case 'create_category':await categoryService(pool,family).create({name:a.name,...(a.parentId?{parentId:a.parentId}:{})});return 'Creé '+(a.parentName?'la subcategoría «'+a.name+'» dentro de «'+a.parentName+'»':'la categoría «'+a.name+'»')+'.';
  case 'set_budget':await budgetService(pool,family,memberId).setBase(a.categoryId,a.amount,a.from);return 'Presupuesto de «'+a.categoryName+'»: '+money(a.amount,fam)+' por mes desde '+monthLabel(a.from)+'. Se renueva solo cada mes.';
  case 'set_budget_month':await budgetService(pool,family,memberId).set(a.month,a.categoryId,a.amount);return 'Listo: en '+monthLabel(a.month)+' el presupuesto de «'+a.categoryName+'» será '+money(a.amount,fam)+'. El presupuesto base no cambió.';
  case 'create_fixed':{
   const day=referenceDate(new Date()).slice(0,7)+'-01';
   await fixedService(pool,family).create({name:a.name,categoryId:a.categoryId,expectedAmount:a.amount,dueDay:a.dueDay,startDate:a.startMonth?a.startMonth+'-01':day});
   return 'Agregué el gasto fijo «'+a.name+'» de '+money(a.amount,fam)+', vence el día '+a.dueDay+'. Queda pendiente cada mes hasta que registres el pago.';
  }
  case 'set_fixed_amount':await fixedService(pool,family).update(a.fixedId,{expectedAmount:a.amount,effectiveFrom:a.from});return '«'+a.fixedName+'» pasa a '+money(a.amount,fam)+' desde '+monthLabel(a.from)+'. Lo pagado y los meses anteriores quedaron igual.';
  case 'set_fixed_active':await fixedService(pool,family).update(a.fixedId,{active:a.active});return '«'+a.fixedName+'» quedó '+(a.active?'activo':'desactivado')+'.';
  case 'pay_fixed':{
   if(!a.paymentMethod)throw new ApiError(400,'Falta el medio de pago.');
   await payOccurrence(pool,family,{role:'admin',memberId},a.occurrenceId,{paymentMethod:a.paymentMethod,amount:a.amount,...(a.date?{date:a.date}:{})});
   return 'Registré el pago de «'+a.fixedName+'» de '+monthLabel(a.period)+' por '+money(a.amount,fam)+'. La obligación quedó pagada y no descuenta de tus presupuestos.';
  }
  case 'bulk_budget':{
   const budgets=budgetService(pool,family,memberId),cats=categoryService(pool,family);
   const known=new Map((await db.query('SELECT id,parent_id FROM appgastos.categories WHERE family_id=$1',[family])).rows.map((r:{id:string;parent_id:string|null})=>[r.id,r.parent_id]));
   // Primero las principales y después las subcategorías: así el límite del padre ya existe cuando se valida la suma de los hijos.
   const ordered=[...a.items].sort((x,y)=>Number(!!(x.categoryId&&known.get(x.categoryId)))-Number(!!(y.categoryId&&known.get(y.categoryId))));
   let applied=0,created=0,skipped:string[]=[];
   for(const i of ordered){
    let id=i.categoryId;
    if(!id&&a.createMissing){id=(await cats.create({name:i.name})).id;created++;}
    if(!id){skipped.push(i.name);continue;}
    await budgets.setBase(id,i.amount,a.from);applied++;
   }
   return 'Listo, fijé '+applied+' presupuesto'+(applied===1?'':'s')+' mensual'+(applied===1?'':'es')+' desde '+monthLabel(a.from)+' (se renuevan solos cada mes)'+(created?' y creé '+created+' categoría'+(created===1?'':'s')+' nueva'+(created===1?'':'s'):'')+'.'+(skipped.length?' Quedaron sin presupuesto por no tener categoría: '+skipped.join(', ')+'.':'');
  }
  case 'bulk_fixed':{
   const fixed=fixedService(pool,family),existing=new Set((await db.query('SELECT name FROM appgastos.fixed_expenses WHERE family_id=$1',[family])).rows.map((r:{name:string})=>normalizeName(r.name)));
   let applied=0;const skipped:string[]=[];
   for(const i of a.items){
    if(!i.dueDay||!i.categoryId||existing.has(normalizeName(i.name))){skipped.push(i.name);continue;}
    await fixed.create({name:i.name,categoryId:i.categoryId,expectedAmount:i.amount,dueDay:i.dueDay,startDate:a.startMonth+'-01'});applied++;
   }
   return 'Listo, agregué '+applied+' gasto'+(applied===1?'':'s')+' fijo'+(applied===1?'':'s')+'. Quedan pendientes cada mes hasta que registres el pago.'+(skipped.length?' Dejé afuera (falta un dato o ya existían): '+skipped.join(', ')+'. Podés cargarlos por texto, por ejemplo «gasto fijo '+skipped[0]+' de $X, vence el día 10».':'');
  }
 }
}
// ---- Correcciones sobre un pedido que YA está listo para confirmar («no, son 120 mil», «mejor el 15», «fue ayer», «en Educación»).
// Se vuelve a un pedido (intención) editable, se aplica lo nuevo y se vuelve a validar: el pedido original no se pierde ni cambia de tipo.
export function actionToIntent(a:StoredAction):AdminIntent|null{
 const base:AdminIntent={action:'none',name:null,parent:null,category:null,fixed:null,amount:null,amountText:null,monthText:null,dateText:null,dueDay:null,active:null,paymentMethod:null};
 const amt=(v:string)=>({amount:String(Number(v)),amountText:String(Number(v))});
 switch(a.type){
  case 'create_category':return {...base,action:'create_category',name:a.name,parent:a.parentName};
  case 'set_budget':return {...base,action:'set_budget',category:a.categoryName,monthText:a.from,...amt(a.amount)};
  case 'set_budget_month':return {...base,action:'set_budget_month',category:a.categoryName,monthText:a.month,...amt(a.amount)};
  case 'create_fixed':return {...base,action:'create_fixed',name:a.name,dueDay:a.dueDay,category:a.categoryName,...amt(a.amount)};
  case 'set_fixed_amount':return {...base,action:'set_fixed_amount',fixed:a.fixedName,monthText:a.from,...amt(a.amount)};
  case 'set_fixed_active':return {...base,action:'set_fixed_active',fixed:a.fixedName,active:a.active};
  case 'pay_fixed':return {...base,action:'pay_fixed',fixed:a.fixedName,monthText:a.period,dateText:a.date??null,paymentMethod:a.paymentMethod,...amt(a.amount)};
  default:return null;
 }
}
const FILLER=/^(?:(?:no|ah no|perdon|perdona|disculpa|mejor|en realidad|corrijo|corregi|queria decir|digo|era|eran|son|es|fue|sera|seria|serian|de|por|a|en|con)[ ,]+)+/;
// Respuesta corta que corrige un dato del pedido listo. null = no parece una corrección simple (se prueba con Gemini).
export function correctionPatch(a:StoredAction,text:string,categories:Row[],today:string):Partial<AdminIntent>|null{
 const t=normalizeName(text).replace(/[.,;:!?¡¿"']/g,' ').replace(/\s+/g,' ').trim().replace(FILLER,'').trim();
 if(!t||t.split(' ').length>5)return null;
 const hasAmount=a.type==='create_fixed'||a.type==='set_budget'||a.type==='set_budget_month'||a.type==='set_fixed_amount'||a.type==='pay_fixed';
 if(a.type==='pay_fixed'&&parsePaymentDate(t,today)&&!/^\d{3,}/.test(t))return {dateText:t};
 if(a.type==='create_fixed'){
  const day=/^(?:vence |vencen |el |dia |los )*(3[01]|[12]\d|[1-9])$/.exec(t);
  if(day)return {dueDay:Number(day[1])};
 }
 if(hasAmount){const n=normalizeTextAmount(t);if(n)return {amount:n,amountText:t};}
 if(a.type==='create_fixed'||a.type==='set_budget'||a.type==='set_budget_month'){
  try{const c=pick(categories,t.replace(/^(?:categoria |la categoria |el |la )+/,'').trim(),'categorías');if(c)return {category:c.name};}catch{/* ambigua: lo resuelve Gemini */}
 }
 return null;
}

// ---- Edición de una lista pendiente (fotos de presupuestos o gastos fijos): excluir una línea, cambiar su importe, su vencimiento o su categoría.
const dropWord=/^(?:sacar|saca|saca la|quitar|quita|excluir|excluí|excluye|elimina|eliminar|borra|borrar|sin|no incluyas|no pongas)\s+(?:el |la |los |las )?(.+)$/;
export function editBulk(a:StoredAction,text:string,categories:Row[]):{action:StoredAction;note:string}|{error:string}|null{
 if(a.type!=='bulk_budget'&&a.type!=='bulk_fixed')return null;
 const t=normalizeName(text).replace(/[.,;:!?¡¿"']/g,' ').replace(/\s+/g,' ').trim();
 const items=a.items as (BulkBudgetItem&BulkFixedItem)[];
 const find=(ref:string)=>{
  const r=normalizeName(ref);
  const exact=items.filter(i=>normalizeName(i.name)===r);if(exact.length===1)return exact[0];
  const part=items.filter(i=>normalizeName(i.name).includes(r)||r.includes(normalizeName(i.name)));
  return part.length===1?part[0]:part.length>1?'ambiguous' as const:null;
 };
 const drop=dropWord.exec(t);
 if(drop){
  const hit=find(drop[1]);
  if(hit==='ambiguous')return {error:'«'+drop[1]+'» puede ser más de una línea. ¿Cuál querés sacar?'};
  if(!hit)return {error:'No encontré «'+drop[1]+'» en la lista. Las líneas son: '+items.map(i=>i.name).join(', ')+'.'};
  return {action:{...a,items:items.filter(i=>i!==hit)} as StoredAction,note:'Saqué «'+hit.name+'».'};
 }
 // «<línea> <importe>», «cambiá <línea> a <importe>», «<línea> vence el 10», «<línea> en <categoría>»: se busca el nombre de la línea al principio.
 const body=t.replace(/^(?:cambia|cambiar|pone|poner|corregi|corregir|mejor|ahora)\s+(?:el |la |los |las )?/,'');
 const hit=[...items].sort((x,y)=>y.name.length-x.name.length).find(i=>body===normalizeName(i.name)||body.startsWith(normalizeName(i.name)+' '));
 if(!hit)return null;
 const rest=body.slice(normalizeName(hit.name).length).trim().replace(/^(?:a|en|son|es|de|:)\s+/,'');
 const day=a.type==='bulk_fixed'?/^(?:vence |vencen )(?:el |los )?(3[01]|[12]\d|[1-9])$/.exec(rest):null;
 if(day)return {action:{...a,items:items.map(i=>i===hit?{...i,dueDay:Number(day[1])}:i)} as StoredAction,note:'Listo, «'+hit.name+'» vence el '+day[1]+'.'};
 const n=normalizeTextAmount(rest);
 if(n)return {action:{...a,items:items.map(i=>i===hit?{...i,amount:n.includes('.')?n:n+'.00',current:i.current}:i)} as StoredAction,note:'Listo, «'+hit.name+'» queda en '+rest+'.'};
 try{
  const c=pick(categories,rest.replace(/^(?:categoria |la categoria )/,''),'categorías');
  if(c)return {action:{...a,items:items.map(i=>i===hit?{...i,categoryId:c.id,categoryName:c.name}:i)} as StoredAction,note:'Listo, «'+hit.name+'» va en «'+c.name+'».'};
 }catch{return {error:'No me quedó claro a qué categoría te referís para «'+hit.name+'».'};}
 return null;
}
export const ADMIN_PAYMENT_CODES=PAYMENT_CODES;
