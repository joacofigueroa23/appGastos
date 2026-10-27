import {formatAmount} from '../whatsapp/replies';
import {receiptProblems,type DraftContext} from './draft';
import {includedItems,primaryCategory,toCents} from './reconcile';
import type {InvoiceDraft,ReceiptDraft,StatementDraft} from './types';
const dmy=(d:string|null)=>d?d.slice(8)+'/'+d.slice(5,7)+'/'+d.slice(0,4):'sin fecha';
const money=(a:string|null,cur:string,fam:string)=>{
 if(a===null)return 'sin total';
 const neg=a.startsWith('-'),abs=neg?a.slice(1):a;
 return (neg?'-':'')+formatAmount(abs.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''),cur,fam);
};
const MAX_LISTED=12;
export const COMMAND_HELP='Respondé *confirmar* para registrarlo o *cancelar* para descartarlo. Podés corregir: «el detergente va en limpieza», «excluir leche», «de la casa», «fecha 10/10», «total 19000», «efectivo».';
// Resumen de un ticket o comprobante de pago. Siempre aclara que todavía NO se registró nada.
export function receiptSummary(d:ReceiptDraft,ctx:DraftContext,code:string):string{
 const cat=(id:string|null)=>id?ctx.categories.find(c=>c.id===id)?.name||'—':'(sin categoría)';
 const head=(d.kind==='payment_receipt'?'💸 Comprobante de pago':'🧾 Ticket')+(d.merchant?' de '+d.merchant:'')+' · '+dmy(d.date);
 const lines:string[]=[head,'Total '+money(d.total,d.currency,ctx.familyCurrency)+' · '+(d.scope==='household'?'gasto de la casa':'gasto personal')];
 const items=d.items.filter(i=>!i.excluded);
 items.slice(0,MAX_LISTED).forEach((i,n)=>lines.push((i.adjustment?'• ':(n+1)+') ')+i.description+' — '+money(i.amount,d.currency,ctx.familyCurrency)+' → '+cat(i.categoryId)+(i.auto?' (automático)':'')));
 if(items.length>MAX_LISTED)lines.push('… y '+(items.length-MAX_LISTED)+' más.');
 const out=d.items.filter(i=>i.excluded);
 if(out.length)lines.push('Excluidos: '+out.map(i=>i.description).join(', ')+'.');
 d.notes.forEach(n=>lines.push('⚠️ '+n));
 if(d.noExpense)lines.push('ℹ️ '+(d.noExpenseReason||'No se registra como gasto.'));
 else if(d.settle)lines.push('🔗 Corresponde al gasto fijo «'+d.settle.label+'»: al confirmar registro UN gasto, lo marco como pagado y no descuenta de tus presupuestos. Si no es ese, respondé *no es gasto fijo*.');
 else if(d.linkExpenseId){
  const x=d.duplicates.find(y=>y.expenseId===d.linkExpenseId);
  lines.push('🔗 Se asociará al gasto que ya cargaste'+(x?' ('+money(x.amount,x.currency,ctx.familyCurrency)+', '+dmy(x.date)+')':'')+': no se crea otro.');
 }else if(d.duplicates.length){
  const x=d.duplicates[0];
  lines.push('⚠️ Ya hay un gasto parecido ('+money(x.amount,x.currency,ctx.familyCurrency)+', '+dmy(x.date)+(x.label?', '+x.label:'')+'). Respondé *vincular* para asociarlo y no duplicar.');
 }
 if(d.kind==='payment_receipt'&&!d.noExpense&&!d.linkExpenseId)lines.push('Si es una transferencia entre tus cuentas o el pago de una tarjeta, respondé *no es gasto*.');
 // Una sola pregunta por vez, en simple: el dato que falta primero (total, fecha, categoría de un renglón, un ajuste o el medio de pago).
 const question=nextQuestion(d,ctx);
 if(question)lines.push(question);
 lines.push('Todavía no registré nada. '+COMMAND_HELP,'Código: '+code);
 return lines.join('\n');
}
// Lo próximo que hay que preguntar para poder registrar el comprobante (null si no falta nada). Una pregunta por vez, con lo necesario para contestarla.
export function nextQuestion(d:ReceiptDraft,ctx:DraftContext):string|null{
 if(d.noExpense||d.linkExpenseId)return null;
 const names=ctx.categories.filter(c=>c.active).map(c=>c.name),list=names.slice(0,15).join(', ')+(names.length>15?'…':'');
 if(d.total===null||toCents(d.total)<=0)return '¿Cuál fue el total del comprobante? (por ejemplo «20 mil»)';
 if(!d.date)return '¿Qué día fue? (hoy, ayer, 12/10…)';
 const items=includedItems(d);
 if(!items.length)return 'No encontré renglones con importe. Contame qué compraste y de cuánto fue, o mandame otra foto.';
 const real=items.filter(i=>!i.adjustment&&!i.categoryId);
 if(real.length)return '¿En qué categoría va «'+real[0].description+'»?'+(real.length>1?' (Después te pregunto por '+(real.length-1)+' más.) ':' ')+'Tus categorías: '+list+'.';
 const adjustment=items.find(i=>i.adjustment&&!i.categoryId);
 if(adjustment){
  const primary=primaryCategory(items.filter(i=>!i.adjustment)),name=ctx.categories.find(c=>c.id===primary)?.name;
  const amount=money(adjustment.amount,d.currency,ctx.familyCurrency);
  return 'Hay un ajuste de '+amount+' ('+adjustment.description.toLowerCase()+') entre los renglones y el total. '+(name?'¿Lo sumo a «'+name+'»? Respondé *sí* o decime otra categoría.':'¿En qué categoría lo ubico? Tus categorías: '+list+'.');
 }
 if(!d.paymentMethod)return '¿Cómo pagaste? Efectivo, débito, crédito, transferencia o billetera.';
 if(d.cardId&&!ctx.cards.some(c=>c.id===d.cardId&&c.active))return '¿Con qué tarjeta? La que había elegido ya no está disponible.';
 return null;
}
export function invoiceSummary(d:InvoiceDraft,admin:boolean,ctx:DraftContext):string{
 const lines=['📄 Factura'+(d.issuer?' de '+d.issuer:'')+(d.amount?' por '+money(d.amount,d.currency,ctx.familyCurrency):'')+(d.dueDate?', vence '+dmy(d.dueDate):'')+'.'];
 d.notes.forEach(n=>lines.push('⚠️ '+n));
 lines.push('No la registré como pagada: una factura recibida es algo pendiente de pago.');
 lines.push(admin?'Podés revisarla en la web (Comprobantes) y asociarla a un gasto fijo.':'Queda pendiente de revisión por un administrador.');
 return lines.join('\n');
}
export function statementSummary(d:StatementDraft,ctx:DraftContext,code:string):string{
 const open=d.lines.filter(l=>!l.excluded).length,blocked=d.lines.filter(l=>l.blockedReason).length,dup=d.lines.filter(l=>l.duplicates.length).length;
 const lines=['💳 Resumen de tarjeta'+(d.issuer?' de '+d.issuer:'')+(d.period?' · '+d.period:'')+': '+d.lines.length+' movimientos.'];
 for(const t of d.totals)lines.push((t.currency)+': consumos '+money(t.lines,t.currency,ctx.familyCurrency)+(t.statement?' · total del resumen '+money(t.statement,t.currency,ctx.familyCurrency):''));
 if(dup)lines.push(dup+' parecen ya estar cargados.');
 if(blocked)lines.push(blocked+' (cuotas, devoluciones o pagos) quedan para revisar: todavía no se importan.');
 d.notes.forEach(n=>lines.push('⚠️ '+n));
 lines.push('Para evitar decenas de mensajes, revisalo y elegí qué importar en la web (Comprobantes). Por defecto no importo nada ('+open+' listos para revisar). Código: '+code);
 return lines.join('\n');
}
export const unknownSummary=(code:string)=>'No pude determinar qué tipo de documento es. Decime cuál es: *ticket*, *factura*, *comprobante de pago*, *resumen*, *presupuestos* (lista de presupuestos) o *gastos fijos* (lista de gastos fijos). Todavía no registré nada. Código: '+code;
export const CONFIRMED_REPLY=(text:string)=>'✅ '+text;
export function confirmedExpenseReply(amount:string,currency:string,fam:string,categories:number,extra=''){
 return '✅ Registrado: '+money(amount,currency,fam)+(categories>1?' en '+categories+' categorías':'')+'.'+extra;
}
export {includedItems};
