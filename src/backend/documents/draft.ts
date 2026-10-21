import {isDateOnly} from '../../utils/finance';
import {PAYMENT_CODES,type PaymentCode} from '../../shared/apiTypes';
import {normalizeName} from '../whatsapp/candidate';
import {fromCents,includedItems,recompute,toCents} from './reconcile';
import type {DocumentKind,DraftItem,DraftLine,Extraction,InvoiceDraft,ReceiptDraft,StatementDraft} from './types';
export interface DraftContext {
 categories:{id:string;name:string;active:boolean}[];cards:{id:string;name:string;active:boolean;cardType:'credit_card'|'debit_card'|null}[];
 familyCurrency:string;today:string;
}
const NOTE_MAX=8;
const categoryId=(ctx:DraftContext,name:string|null)=>name?ctx.categories.find(c=>c.active&&normalizeName(c.name)===normalizeName(name))?.id??null:null;
// Un documento no es lo que parece solo por lo que diga el modelo. Regla conservadora: ante una contradicción, nunca se registra como pagado.
export function classify(e:Extraction):DocumentKind{
 if(e.documentType==='purchase_receipt'&&e.paymentStatus==='unpaid')return 'pending_invoice';
 if(e.documentType==='payment_receipt'&&e.paymentStatus==='unpaid')return 'unknown';
 if(e.documentType==='purchase_receipt'&&e.totalAmount===null&&!e.items.some(i=>i.amount))return 'unknown';
 if(e.documentType==='card_statement'&&!e.lines.length)return 'unknown';
 return e.documentType;
}
export function buildReceiptDraft(e:Extraction,ctx:DraftContext,kind:'purchase_receipt'|'payment_receipt',householdHint:boolean):ReceiptDraft{
 const notes:string[]=[],currency=e.currency||ctx.familyCurrency;
 if(!e.currency)notes.push('Moneda no detectada: asumí '+ctx.familyCurrency+'.');
 const usable=e.items.filter(i=>i.amount);
 const dropped=e.items.length-usable.length;
 if(dropped)notes.push(dropped+' concepto(s) sin importe legible: no se incluyeron.');
 let items:DraftItem[]=usable.map((i,n)=>({id:n+1,description:i.description,amount:i.amount!,categoryId:categoryId(ctx,i.category),excluded:false}));
 let total=e.totalAmount;
 if(total===null&&items.length){total=fromCents(items.reduce((n,i)=>n+toCents(i.amount),0));notes.push('El comprobante no muestra un total legible: usé la suma de los conceptos.');}
 if(!items.length&&total)items=[{id:1,description:e.merchant||(kind==='payment_receipt'?'Pago':'Compra'),amount:total,categoryId:categoryId(ctx,e.category),excluded:false}];
 const noExpense=kind==='payment_receipt'&&(e.isCardPayment===true||e.isOwnTransfer===true);
 const draft:ReceiptDraft={
  kind,scope:householdHint?'household':'personal',currency,date:e.documentDate,merchant:e.merchant,
  description:e.merchant?(kind==='payment_receipt'?'Pago a ':'Compra en ')+e.merchant:kind==='payment_receipt'?'Pago con comprobante':'Compra con comprobante',
  total,items,components:{discounts:e.discounts,taxes:e.taxes,surcharges:e.surcharges,taxesIncluded:e.taxesIncluded===true},
  paymentMethod:e.paymentMethod,cardId:null,duplicates:[],linkExpenseId:null,noExpense,
  noExpenseReason:noExpense?(e.isCardPayment?'Parece el pago de un resumen de tarjeta: los consumos ya están en el resumen, no es un gasto nuevo.':'Parece una transferencia entre cuentas propias: no es un gasto.'):null,
  paymentReference:e.paymentReference,notes:[...notes,...e.warnings].slice(0,NOTE_MAX),
 };
 return recompute(draft);
}
export function buildInvoiceDraft(e:Extraction,ctx:DraftContext):InvoiceDraft{
 const notes=[...e.warnings];
 if(e.paymentStatus==='paid')notes.push('El documento dice "pagado": si ya pagaste, mandá el comprobante de pago.');
 return {kind:'pending_invoice',issuer:e.merchant,concept:e.concept,period:e.statementPeriod,amount:e.totalAmount,currency:e.currency||ctx.familyCurrency,
  issueDate:e.documentDate,dueDate:e.dueDate,reference:e.invoiceReference,notes:notes.slice(0,NOTE_MAX)};
}
// Reglas contables aprobadas para los resúmenes:
//  - cuotas: la compra se registra UNA vez, al inicio (cuota 1), por el total (cuota × cantidad) con la cantidad de meses. Las cuotas 2 en adelante
//    no se importan: la compra ya está registrada y contarlas de nuevo sería duplicar.
//  - devoluciones: restan del gasto original, que el usuario elige entre candidatos; sin gasto original no se importan.
//  - pagos del resumen anterior (y transferencias propias): no son consumos.
export const BLOCKED:Record<string,string>={installment:'Cuota: la compra ya se registró al inicio; no se cuenta otra vez.',refund:'Devolución: no encontré el gasto original al que restarla.',payment:'Pago del resumen: no es un consumo.',no_date:'Sin fecha legible.',no_amount:'Sin importe legible.'};
export function buildStatementDraft(e:Extraction,ctx:DraftContext):StatementDraft{
 const notes=[...e.warnings];
 const lines:DraftLine[]=[];
 let skipped=0;
 for(const l of e.lines){
  if(!l.amount){skipped++;continue;}
  const negative=l.amount.startsWith('-');
  // Cualquier línea negativa (salvo el pago del resumen) reduce lo debido: es una devolución o bonificación, nunca un gasto positivo.
  const kind=l.kind==='payment'?'payment':negative?'refund':l.kind;
  const later=!!l.installmentTotal&&(l.installmentCurrent||1)>1;
  // Una devolución arranca bloqueada hasta que se le encuentra un gasto original (duplicates.ts); una cuota 1 se importa por el total de la compra.
  const blocked=later?'installment':kind==='refund'?'refund':kind==='payment'?'payment':!l.date?'no_date':null;
  lines.push({id:lines.length+1,date:l.date,merchant:l.merchant,amount:l.amount.replace('-',''),currency:l.currency||e.currency||ctx.familyCurrency,kind,
   installment:l.installmentTotal?{current:l.installmentCurrent!,total:l.installmentTotal}:null,categoryId:categoryId(ctx,l.category),excluded:blocked!==null,
   blockedReason:blocked,duplicates:[],refundCandidates:[],refundOf:null,acceptDuplicate:false,scope:'personal'});
 }
 if(skipped)notes.push(skipped+' línea(s) sin importe legible: no se incluyeron.');
 return {kind:'card_statement',issuer:e.merchant,period:e.statementPeriod,closingDate:e.closingDate,dueDate:e.dueDate,cardId:null,lines,totals:statementTotals(lines,e),notes:notes.slice(0,NOTE_MAX)};
}
// Por moneda: total que declara el resumen frente a la suma de sus líneas (compras y cargos suman; devoluciones restan; pagos no cuentan).
export function statementTotals(lines:DraftLine[],e:Pick<Extraction,'statementTotals'>){
 const sums=new Map<string,number>();
 for(const l of lines){
  if(l.kind==='payment')continue;
  sums.set(l.currency,(sums.get(l.currency)||0)+(l.kind==='refund'?-1:1)*toCents(l.amount));
 }
 const declared=new Map(e.statementTotals.map(t=>[t.currency,t.total]));
 return [...new Set([...sums.keys(),...declared.keys()])].map(c=>({currency:c,statement:declared.get(c)??null,lines:fromCents(sums.get(c)||0)}));
}

// ---- Qué falta para poder registrar un ticket o comprobante de pago.
export function receiptProblems(d:ReceiptDraft,ctx:DraftContext):string[]{
 if(d.noExpense||d.linkExpenseId)return [];
 const problems:string[]=[];
 if(d.total===null||toCents(d.total)<=0)problems.push('el total');
 if(!d.date)problems.push('la fecha');
 const items=includedItems(d);
 if(!items.length)problems.push('al menos un concepto');
 for(const i of items)if(!i.categoryId)problems.push('la categoría de «'+i.description+'»');
 if(!d.paymentMethod)problems.push('el medio de pago');
 if(d.cardId&&!ctx.cards.some(c=>c.id===d.cardId&&c.active))problems.push('una tarjeta válida');
 return problems;
}

// ---- Ediciones del borrador. Las usan el chat y la web: así hay una sola regla.
export type Edit=
 |{type:'scope';value:'personal'|'household'}|{type:'date';value:string}|{type:'total';value:string}
 |{type:'paymentMethod';value:PaymentCode}|{type:'cardId';value:string|null}|{type:'noExpense';value:boolean}|{type:'link';expenseId:string|null}
 |{type:'itemCategory';itemId:number;categoryId:string|null}|{type:'itemExcluded';itemId:number;excluded:boolean}
 |{type:'lineCategory';lineId:number;categoryId:string|null}|{type:'lineExcluded';lineId:number;excluded:boolean}
 |{type:'lineAcceptDuplicate';lineId:number;value:boolean}|{type:'lineRefundOf';lineId:number;expenseId:string|null}|{type:'lineScope';lineId:number;value:'personal'|'household'};
export type EditResult={draft:ReceiptDraft|StatementDraft;error?:undefined}|{draft?:undefined;error:string};
const fail=(error:string):EditResult=>({error});
export function applyEdit(draft:ReceiptDraft|StatementDraft,edit:Edit,ctx:DraftContext):EditResult{
 const activeCategory=(id:string|null)=>id===null||ctx.categories.some(c=>c.id===id&&c.active);
 if(draft.kind==='card_statement'){
  if(edit.type==='cardId'){
   if(edit.value&&!ctx.cards.some(c=>c.id===edit.value&&c.active))return fail('Esa tarjeta no existe o está inactiva.');
   return {draft:{...draft,cardId:edit.value}};
  }
  if(!('lineId' in edit))return fail('Ese cambio no aplica a un resumen de tarjeta.');
  const line=draft.lines.find(l=>l.id===edit.lineId);
  if(!line)return fail('Esa línea no existe.');
  let next:DraftLine={...line};
  if(edit.type==='lineCategory'){if(!activeCategory(edit.categoryId))return fail('Esa categoría no existe o está inactiva.');next.categoryId=edit.categoryId;}
  else if(edit.type==='lineExcluded'){
   if(line.blockedReason&&!edit.excluded)return fail(BLOCKED[line.blockedReason]+' No se puede importar todavía.');
   next.excluded=edit.excluded;
  }
  else if(edit.type==='lineRefundOf'){
   if(line.kind!=='refund')return fail('Eso no es una devolución.');
   if(edit.expenseId&&!line.refundCandidates.some(c=>c.expenseId===edit.expenseId))return fail('Ese gasto no está entre los candidatos.');
   next={...next,refundOf:edit.expenseId,blockedReason:edit.expenseId?null:'refund',excluded:!edit.expenseId};
  }
  else if(edit.type==='lineAcceptDuplicate')next={...next,acceptDuplicate:edit.value,excluded:edit.value?false:next.excluded||next.duplicates.length>0};
  else if(edit.type==='lineScope')next.scope=edit.value;
  return {draft:{...draft,lines:draft.lines.map(l=>l.id===line.id?next:l)}};
 }
 let d:ReceiptDraft=draft;
 switch(edit.type){
  case 'scope':d={...d,scope:edit.value};break;
  case 'date':if(!isDateOnly(edit.value))return fail('Esa fecha no es válida.');d={...d,date:edit.value};break;
  case 'total':{
   if(!/^\d{1,12}(\.\d{1,2})?$/.test(edit.value)||toCents(edit.value)<=0)return fail('Ese total no es válido.');
   d={...d,total:edit.value.includes('.')?edit.value:edit.value+'.00'};break;
  }
  case 'paymentMethod':if(!(PAYMENT_CODES as readonly string[]).includes(edit.value))return fail('Medio de pago inválido.');d={...d,paymentMethod:edit.value,cardId:null};break;
  case 'cardId':if(edit.value&&!ctx.cards.some(c=>c.id===edit.value&&c.active))return fail('Esa tarjeta no existe o está inactiva.');d={...d,cardId:edit.value};break;
  case 'noExpense':d={...d,noExpense:edit.value,noExpenseReason:edit.value?d.noExpenseReason||'Indicaste que no es un gasto.':null,linkExpenseId:edit.value?null:d.linkExpenseId};break;
  case 'link':
   if(edit.expenseId&&!d.duplicates.some(x=>x.expenseId===edit.expenseId))return fail('Ese gasto no está entre las coincidencias.');
   d={...d,linkExpenseId:edit.expenseId,noExpense:edit.expenseId?false:d.noExpense};break;
  case 'itemCategory':{
   const item=d.items.find(i=>i.id===edit.itemId);
   if(!item)return fail('Ese concepto no existe.');
   if(!activeCategory(edit.categoryId))return fail('Esa categoría no existe o está inactiva.');
   d={...d,items:d.items.map(i=>i.id===item.id?{...i,categoryId:edit.categoryId}:i)};break;
  }
  case 'itemExcluded':{
   const item=d.items.find(i=>i.id===edit.itemId);
   if(!item)return fail('Ese concepto no existe.');
   if(item.adjustment)return fail('Un ajuste no se puede excluir: asignale una categoría.');
   // Excluir un concepto mal leído también lo saca del total: si no, el importe registrado seguiría siendo el de antes.
   const delta=edit.excluded===item.excluded||d.total===null?0:(edit.excluded?-1:1)*toCents(item.amount);
   d={...d,total:d.total===null?null:fromCents(toCents(d.total)+delta),items:d.items.map(i=>i.id===item.id?{...i,excluded:edit.excluded}:i)};break;
  }
  default:return fail('Ese cambio no aplica a un comprobante.');
 }
 return {draft:recompute(d)};
}
