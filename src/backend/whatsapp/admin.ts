import type {Pool} from 'pg';
import {randomInt} from 'node:crypto';
import {PAYMENT_CODES,type PaymentCode} from '../../shared/apiTypes';
import {ApiError} from '../shared/errors';
import {categoryService} from '../categories/service';
import {budgetService} from '../budgets/service';
import {fixedService,generateOccurrences} from '../fixed/service';
import {payOccurrence} from '../fixed/pay';
import type {Connection} from '../expenses/repository';
import {normalizeName,normalizeTextAmount,referenceDate} from './candidate';
import {formatAmount} from './replies';
import {addMonths,parseMonthText,upcomingMonth,type AdminIntent,type MonthRef} from './adminIntent';
import {parseCommand} from '../documents/commands';
// Administración conversacional. Cada pedido del administrador se interpreta (Gemini), el backend lo valida y lo guarda como una acción
// PENDIENTE con un código; recién al confirmar se ejecuta, con los mismos servicios (y reglas) que usa la web. Nada se ejecuta por lo que
// diga el modelo. La identidad y el rol salen del número vinculado, nunca del mensaje.
export type StoredAction=
 |{type:'create_category';name:string;parentId:string|null;parentName:string|null}
 |{type:'set_budget';categoryId:string;categoryName:string;amount:string;from:string}
 |{type:'set_budget_month';categoryId:string;categoryName:string;amount:string;month:string}
 |{type:'create_fixed';name:string;amount:string;dueDay:number;categoryId:string|null;categoryName:string|null;startMonth:string}
 |{type:'set_fixed_amount';fixedId:string;fixedName:string;amount:string;from:string}
 |{type:'set_fixed_active';fixedId:string;fixedName:string;active:boolean}
 |{type:'pay_fixed';occurrenceId:string;fixedName:string;period:string;amount:string;paymentMethod:PaymentCode|null};
const TTL_MINUTES=15;
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode=()=>Array.from({length:4},()=>CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const MONTH_NAMES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const monthLabel=(key:string)=>MONTH_NAMES[Number(key.slice(5,7))-1]+' de '+key.slice(0,4);
const PAYMENT_NAMES:Record<PaymentCode,string>={cash:'efectivo',debit_card:'débito',credit_card:'crédito',transfer:'transferencia',wallet:'billetera',other:'otro medio'};
const money=(v:string,fam:string)=>formatAmount(v.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''),fam,fam);
class Ask extends Error {}

interface Row {id:string;name:string;active:boolean;parent_id?:string|null}
const pick=(rows:Row[],ref:string|null,label:string):Row|null=>{
 if(!ref)return null;
 const r=normalizeName(ref),active=rows.filter(x=>x.active),pool=active.length?active:rows;
 const exact=pool.filter(x=>normalizeName(x.name)===r);if(exact.length===1)return exact[0];
 const part=pool.filter(x=>normalizeName(x.name).includes(r)||r.includes(normalizeName(x.name)));
 if(part.length===1)return part[0];
 if(part.length>1)throw new Ask('Hay varias '+label+' que coinciden con «'+ref+'»: '+part.slice(0,5).map(x=>x.name).join(', ')+'. Decime cuál con su nombre completo.');
 return null;
};
const needAmount=(i:AdminIntent)=>{
 const parsed=i.amountText?normalizeTextAmount(i.amountText):null;
 if(!parsed||!i.amount||Number(parsed)!==Number(i.amount)||Number(parsed)<=0)throw new Ask('No pude entender el importe. Decímelo de nuevo, por ejemplo «$500.000».');
 return parsed.includes('.')?parsed:parsed+'.00';
};

// ---- Preparación: valida y deja la acción pendiente. No cambia ninguna configuración.
export async function prepareAdminAction(pool:Pool,family:string,member:{id:string},intent:AdminIntent,at:Date,familyCurrency:string):Promise<{outcome:'admin_config';reply:string}|null>{
 if(intent.action==='none')return null;
 const today=referenceDate(at),cur=today.slice(0,7);
 const categories=(await pool.query('SELECT id,name,active,parent_id FROM appgastos.categories WHERE family_id=$1',[family])).rows as Row[];
 const fixedRows=(await pool.query('SELECT id,name,active FROM appgastos.fixed_expenses WHERE family_id=$1',[family])).rows as Row[];
 let action:StoredAction;
 try{
  const category=()=>{const c=pick(categories,intent.category,'categorías');if(!c)throw new Ask('No encontré esa categoría. Las tuyas: '+categories.filter(x=>x.active).map(x=>x.name).join(', ')+'.');return c;};
  const fixed=()=>{const f=pick(fixedRows,intent.fixed,'obligaciones');if(!f)throw new Ask('No encontré ese gasto fijo. Los tuyos: '+(fixedRows.map(x=>x.name).join(', ')||'ninguno')+'.');return f;};
  const monthRef=parseMonthText(intent.monthText);
  const from=(ref:MonthRef|null)=>ref?upcomingMonth(ref,today):cur;
  switch(intent.action){
   case 'create_category':{
    if(!intent.name)throw new Ask('¿Cómo se llama la categoría?');
    if(categories.some(c=>normalizeName(c.name)===normalizeName(intent.name!)))throw new Ask('Ya existe una categoría llamada «'+intent.name+'».');
    const parent=intent.parent?pick(categories,intent.parent,'categorías'):null;
    if(intent.parent&&!parent)throw new Ask('No encontré la categoría principal «'+intent.parent+'». Las tuyas: '+categories.filter(x=>!x.parent_id&&x.active).map(x=>x.name).join(', ')+'.');
    if(parent?.parent_id)throw new Ask('«'+parent.name+'» ya es una subcategoría: solo hay dos niveles.');
    action={type:'create_category',name:intent.name,parentId:parent?.id??null,parentName:parent?.name??null};break;
   }
   case 'set_budget':{const c=category();action={type:'set_budget',categoryId:c.id,categoryName:c.name,amount:needAmount(intent),from:from(monthRef)};break;}
   case 'set_budget_month':{
    const c=category();if(!monthRef)throw new Ask('¿Para qué mes es la excepción? Por ejemplo «diciembre».');
    action={type:'set_budget_month',categoryId:c.id,categoryName:c.name,amount:needAmount(intent),month:upcomingMonth(monthRef,today)};break;
   }
   case 'create_fixed':{
    if(!intent.name)throw new Ask('¿Cómo se llama el gasto fijo?');
    if(!intent.dueDay)throw new Ask('¿Qué día del mes vence «'+intent.name+'»?');
    if(fixedRows.some(f=>normalizeName(f.name)===normalizeName(intent.name!)))throw new Ask('Ya existe un gasto fijo llamado «'+intent.name+'».');
    const c=intent.category?category():null;
    action={type:'create_fixed',name:intent.name,amount:needAmount(intent),dueDay:intent.dueDay,categoryId:c?.id??null,categoryName:c?.name??null,startMonth:cur};break;
   }
   case 'set_fixed_amount':{const f=fixed();action={type:'set_fixed_amount',fixedId:f.id,fixedName:f.name,amount:needAmount(intent),from:from(monthRef)};break;}
   case 'set_fixed_active':{
    const f=fixed();if(intent.active===null)throw new Ask('¿Querés activar o desactivar «'+f.name+'»?');
    action={type:'set_fixed_active',fixedId:f.id,fixedName:f.name,active:intent.active};break;
   }
   case 'pay_fixed':{
    const f=fixed();
    // Las obligaciones de los próximos 12 meses se generan (idempotente) para poder pagar por adelantado.
    await generateOccurrences(pool,family,'0001-01',addMonths(cur,12));
    const all=(await pool.query(`SELECT o.id,to_char(o.period,'YYYY-MM') AS period,o.expected_amount::text AS amount,(o.expense_id IS NOT NULL) AS paid FROM appgastos.fixed_expense_occurrences o
     WHERE o.family_id=$1 AND o.fixed_expense_id=$2 ORDER BY o.period`,[family,f.id])).rows as {id:string;period:string;amount:string;paid:boolean}[];
    let candidates:typeof all,alreadyPaid=false;
    if(monthRef){
     const sameMonth=all.filter(o=>monthRef.month?Number(o.period.slice(5,7))===monthRef.month&&(!monthRef.year||Number(o.period.slice(0,4))===monthRef.year):o.period===upcomingMonth(monthRef,today));
     // Sin año, manda lo pasado o actual (si todas figuran pagadas, se avisa); solo si ese mes todavía no empezó se toma el próximo.
     const past=monthRef.year||!monthRef.month?sameMonth:sameMonth.filter(o=>o.period<=cur);
     const scope=past.length?past:sameMonth.filter(o=>!o.paid).slice(0,1);
     candidates=scope.filter(o=>!o.paid);alreadyPaid=!candidates.length&&scope.some(o=>o.paid);
    }else candidates=all.filter(o=>!o.paid&&o.period<=cur);
    if(!candidates.length)throw new Ask(alreadyPaid?'«'+f.name+'» ya figura como pagado en ese mes. No registré nada.':'No encontré una obligación pendiente de «'+f.name+'»'+(monthRef?' para ese mes':'')+'.');
    if(candidates.length>1)throw new Ask('«'+f.name+'» tiene varias obligaciones pendientes: '+candidates.slice(0,6).map(o=>monthLabel(o.period)).join(', ')+'. ¿De qué mes es el pago? Por ejemplo «ya pagué '+f.name.toLowerCase()+' de '+MONTH_NAMES[Number(candidates[0].period.slice(5,7))-1]+'».');
    const o=candidates[0],amount=intent.amountText?needAmount(intent):o.amount;
    action={type:'pay_fixed',occurrenceId:o.id,fixedName:f.name,period:o.period,amount,paymentMethod:intent.paymentMethod};break;
   }
  }
 }catch(error){
  if(error instanceof Ask)return {outcome:'admin_config',reply:error.message};
  throw error;
 }
 return store(pool,family,member.id,action,at,familyCurrency);
}

const missing=(a:StoredAction):'category'|'paymentMethod'|null=>a.type==='create_fixed'&&!a.categoryId?'category':a.type==='pay_fixed'&&!a.paymentMethod?'paymentMethod':null;
export function describe(a:StoredAction,fam:string):string{
 switch(a.type){
  case 'create_category':return a.parentName?'crear la subcategoría «'+a.name+'» dentro de «'+a.parentName+'»':'crear la categoría «'+a.name+'»';
  case 'set_budget':return 'fijar el presupuesto mensual de «'+a.categoryName+'» en '+money(a.amount,fam)+' desde '+monthLabel(a.from)+' (se renueva solo cada mes; no cambia los meses anteriores)';
  case 'set_budget_month':return 'usar '+money(a.amount,fam)+' de presupuesto para «'+a.categoryName+'» solo en '+monthLabel(a.month)+' (el presupuesto base no cambia)';
  case 'create_fixed':return 'agregar el gasto fijo «'+a.name+'» de '+money(a.amount,fam)+', vence el día '+a.dueDay+(a.categoryName?', categoría «'+a.categoryName+'»':'');
  case 'set_fixed_amount':return 'cambiar el importe de «'+a.fixedName+'» a '+money(a.amount,fam)+' desde '+monthLabel(a.from)+' (lo ya pagado y los meses anteriores no cambian)';
  case 'set_fixed_active':return (a.active?'reactivar':'desactivar')+' el gasto fijo «'+a.fixedName+'»'+(a.active?'':' (deja de generar obligaciones nuevas; las pagadas se conservan)');
  case 'pay_fixed':return 'registrar el pago de «'+a.fixedName+'» de '+monthLabel(a.period)+' por '+money(a.amount,fam)+(a.paymentMethod?' con '+PAYMENT_NAMES[a.paymentMethod]:'')+'. Se registra UN solo gasto de la casa y la obligación queda pagada';
 }
}
async function store(pool:Pool,family:string,memberId:string,action:StoredAction,at:Date,fam:string){
 const docCodes=new Set((await pool.query("SELECT short_code FROM appgastos.documents WHERE family_id=$1 AND state IN ('received','processing','needs_review')",[family])).rows.map((r:{short_code:string})=>r.short_code));
 const summary=describe(action,fam);
 const replaced=(await pool.query("UPDATE appgastos.admin_actions SET state='cancelled' WHERE family_id=$1 AND member_id=$2 AND state='pending' RETURNING id",[family,memberId])).rowCount;
 let code=newCode();while(docCodes.has(code))code=newCode();
 for(let attempt=0;attempt<6;attempt++){
  const r=await pool.query(`INSERT INTO appgastos.admin_actions(family_id,member_id,short_code,action,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[family,memberId,code,JSON.stringify(action),summary,new Date(at.getTime()+TTL_MINUTES*60000)]);
  if(r.rowCount)return {outcome:'admin_config' as const,reply:prompt(action,summary,code,!!replaced)};
  code=newCode();
 }
 return {outcome:'admin_config' as const,reply:'No pude preparar la acción ahora. Probá de nuevo en un momento.'};
}
const prompt=(a:StoredAction,summary:string,code:string,replaced:boolean)=>{
 const need=missing(a);
 return (replaced?'(Reemplacé tu pedido anterior sin aplicarlo.)\n':'')+'📝 Voy a '+summary+'.\n'+
  (need==='category'?'Antes decime en qué categoría lo ubico (por ejemplo «categoría Educación»). ':need==='paymentMethod'?'Antes decime con qué medio pagaste (efectivo, débito, crédito, transferencia o billetera). ':'')+
  'Respondé *confirmar* para aplicarlo o *cancelar* para descartarlo. Código: '+code;
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
  return cmd?say('Ese pedido venció (pasaron más de '+TTL_MINUTES+' minutos). Pedilo de nuevo y lo preparo.'):null;
 }
 const action=pending.action,need=missing(action);
 const update=async(next:StoredAction)=>{
  await db.query('UPDATE appgastos.admin_actions SET action=$2,summary=$3,expires_at=$4 WHERE id=$1',[pending.id,JSON.stringify(next),describe(next,familyCurrency),new Date(at.getTime()+TTL_MINUTES*60000)]);
  return say(prompt(next,describe(next,familyCurrency),pending.short_code,false));
 };
 if(cmd?.type==='cancel'){await db.query("UPDATE appgastos.admin_actions SET state='cancelled' WHERE id=$1",[pending.id]);return say('Listo, no hice ningún cambio.');}
 // Completar el dato que falta.
 if(need==='paymentMethod'&&cmd?.type==='payment'&&action.type==='pay_fixed')return update({...action,paymentMethod:cmd.value});
 if(need==='category'&&action.type==='create_fixed'&&!cmd){
  const cats=(await db.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1',[family])).rows as Row[];
  let c:Row|null=null;
  try{c=pick(cats,text.replace(/^\s*(?:en la |en el |a la |al |la |el )?categor[ií]a\s+/i,'').trim(),'categorías');}catch{c=null;}
  if(c)return update({...action,categoryId:c.id,categoryName:c.name});
  return say('No encontré esa categoría. Las tuyas: '+cats.filter(x=>x.active).map(x=>x.name).join(', ')+'.');
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
   await payOccurrence(pool,family,{role:'admin',memberId},a.occurrenceId,{paymentMethod:a.paymentMethod,amount:a.amount});
   return 'Registré el pago de «'+a.fixedName+'» de '+monthLabel(a.period)+' por '+money(a.amount,fam)+'. La obligación quedó pagada y no descuenta de tus presupuestos.';
  }
 }
}
export const ADMIN_PAYMENT_CODES=PAYMENT_CODES;
