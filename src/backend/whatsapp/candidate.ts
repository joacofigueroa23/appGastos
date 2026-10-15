
import {PAYMENT_CODES,type CardType,type ExpenseWrite,type PaymentCode} from '../../shared/apiTypes';
import {normalizeAmount,validateExpenseWrite} from '../expenses/validation';
import {isDateOnly} from '../../utils/finance';

export interface CatalogEntry {id:string;name:string;active:boolean}
export interface CardEntry extends CatalogEntry {cardType:CardType|null}
export interface Interpretation {
 amount:string|null; amountText:string|null; dateText:string|null;
 currency:string|null; currencyText:string|null; merchant:string|null;
 description:string|null; category:string|null; paymentMethod:PaymentCode|null;
 paymentMethodText:string|null; card:string|null;
}
export interface ExpenseCandidate {
 date:string|null;amount:string|null;currency:string|null;merchant:string|null;
 description:string|null;category:string|null;paymentMethod:PaymentCode|null;card:string|null;
 reportedByMemberId:string;missingFields:string[];
}
export interface InterpretationContext {
 text:string;referenceDate:string;defaultCurrency:string;
 categories:CatalogEntry[];cards:CardEntry[];member:CatalogEntry;
}
// detail: código técnico sin datos del mensaje (ej. http_404), para diagnosticar sin adivinar.
export class InterpretationError extends Error {constructor(message:string,public detail?:string){super(message);}}
// Billeteras virtuales (QR o transferencia desde la app): nunca son tarjeta.
const WALLET=/\b(billetera|mercado ?pago|mp|qr)\b/;
const keys=['amount','amountText','dateText','currency','currencyText','merchant','description','category','paymentMethod','paymentMethodText','card'] as const;
export function parseInterpretation(raw:unknown):Interpretation {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new InterpretationError('invalid_output');
 const obj=raw as Record<string,unknown>;
 if(Object.keys(obj).some(k=>!(keys as readonly string[]).includes(k))||keys.some(k=>!(k in obj)))throw new InterpretationError('invalid_output');
 for(const k of keys)if(obj[k]!==null&&(typeof obj[k]!=='string'||!(obj[k] as string).trim()||(obj[k] as string).length>4096))throw new InterpretationError('invalid_output');
 if(obj.paymentMethod!==null&&!(PAYMENT_CODES as readonly unknown[]).includes(obj.paymentMethod))throw new InterpretationError('invalid_output');
 return obj as unknown as Interpretation;
}
export function normalizeName(s:string){return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');}
export function referenceDate(now:Date,timeZone=process.env.APP_TIME_ZONE||'America/Argentina/Buenos_Aires'):string{
 const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 return ['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-');
}
export function resolveDate(value:string|null,reference:string):string|null{
 if(!value)return reference;
 const v=normalizeName(value);
 if(v==='hoy')return reference;
 if(['ayer','anteayer','manana'].includes(v)){
  const d=new Date(reference+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+(v==='manana'?1:v==='anteayer'?-2:-1));return d.toISOString().slice(0,10);
 }
 if(/^\d{4}-\d{2}-\d{2}$/.test(v))return isDateOnly(v)?v:null;
 const numeric=v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
 const names=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
 const named=v.match(/^(\d{1,2}) (?:de )?([a-z]+)(?: de (\d{4}))?$/);
 let out:string|null=null;
 if(numeric)out=(numeric[3]||reference.slice(0,4))+'-'+numeric[2].padStart(2,'0')+'-'+numeric[1].padStart(2,'0');
 if(named&&names.includes(named[2]))out=(named[3]||reference.slice(0,4))+'-'+String(names.indexOf(named[2])+1).padStart(2,'0')+'-'+named[1].padStart(2,'0');
 return out&&isDateOnly(out)?out:null;
}
export function normalizeTextAmount(raw:string):string|null{
 let s=raw.trim().replace(/^(?:ARS|USD|EUR|U\$S|US\$|\$)\s*/i,'').replace(/\s*(?:ARS|USD|EUR)$/i,'');
 // Multiplicador coloquial de miles: "15 mil", "15k", "2 lucas", "1,5 mil".
 const thousands=s.match(/^(.+?)\s*(?:mil|k|lucas?)$/i);
 if(thousands)s=thousands[1];
 if(/^(?:\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(s))s=s.replace(/\./g,'').replace(',','.');
 else if(/^\d+,\d{1,2}$/.test(s))s=s.replace(',','.');
 else if(/^\d{1,3}(?:\.\d{3})+$/.test(s))s=s.replace(/\./g,'');
 try{
  const n=normalizeAmount(s);
  if(!thousands)return n;
  const cents=BigInt(n.replace('.',''))*1000n;
  return normalizeAmount((cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0'));
 }catch{return null;}
}
function amountEvidence(rawMessage:string,rawFragment:string|null):boolean{
 if(!rawFragment)return false;
 const message=rawMessage.toLowerCase(),fragment=rawFragment.toLowerCase();
 let start=message.indexOf(fragment);
 while(start>=0){
  const before=message[start-1]||'',after=message[start+fragment.length]||'';
  if(!/[0-9.,]/.test(before)&&!/[0-9.,]/.test(after))return true;
  start=message.indexOf(fragment,start+1);
 }
 return false;
}
function paymentEvidence(s:string):PaymentCode|null {
 const t=normalizeName(s);
 if(/\bcredito\b/.test(t)&&/\bdebito\b/.test(t))return null;
 if(/\bcredito\b/.test(t))return 'credit_card';
 if(/\bdebito\b/.test(t))return 'debit_card';
 if(/\befectivo\b/.test(t))return 'cash';
 if(/\btransfer(encia|i|ido|ida)?\b/.test(t))return 'transfer';
 if(WALLET.test(t))return 'wallet';
 if(/\botro medio\b/.test(t))return 'other';
 return null;
}
export function validateExpenseCandidate(raw:Interpretation,ctx:InterpretationContext){
 const missingFields:string[]=[],validationErrors:string[]=[];
 const evidence=(s:string|null)=>s!==null&&normalizeName(ctx.text).includes(normalizeName(s));
 // A missing extraction of an explicit recognizable date cannot silently become today.
 const explicitDates=[...ctx.text.matchAll(/\b(?:hoy|ayer|anteayer|ma\u00f1ana|lunes|martes|mi\u00e9rcoles|jueves|viernes|s\u00e1bado|domingo|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?: de \d{4})?)\b/gi)].map(match=>match[0]);
 const explicitDate=explicitDates[0]||null;
 const dateText=raw.dateText??explicitDate;
 const date=resolveDate(dateText,ctx.referenceDate);
 if(dateText&&!evidence(dateText))validationErrors.push('fecha sin respaldo en el mensaje');
 if(!date)validationErrors.push('fecha inválida o ambigua');
 if(explicitDates.some(fragment=>resolveDate(fragment,ctx.referenceDate)!==date))validationErrors.push('referencias de fecha contradictorias o sin resolver');
 let amount:string|null=null;
 if(raw.amount===null)missingFields.push('monto');
 else{
  try{amount=normalizeAmount(raw.amount);}catch{validationErrors.push('monto inválido');}
  if(!evidence(raw.amountText)||!amountEvidence(ctx.text,raw.amountText)||normalizeTextAmount(raw.amountText||'')!==amount)validationErrors.push('monto sin respaldo en el mensaje');
 }
 const currencyCodes=Intl.supportedValuesOf('currency');
 const explicitCurrency=ctx.text.match(new RegExp('\\b('+currencyCodes.join('|')+')\\b|d[oó]lares|u\\$s|us\\$|euros|pesos argentinos|reales|libras','gi'));
 const currencyCode=(value:string)=>{
  const label=normalizeName(value);
  return currencyCodes.includes(label.toUpperCase())?label.toUpperCase():
   label==='dolares'||label==='u$s'||label==='us$'?'USD':label==='euros'?'EUR':label==='pesos argentinos'?'ARS':label==='reales'?'BRL':label==='libras'?'GBP':null;
 };
 let currency=raw.currency??ctx.defaultCurrency;
 if(raw.currency!==null){
  if(!evidence(raw.currencyText))validationErrors.push('moneda sin respaldo en el mensaje');
  const label=normalizeName(raw.currencyText||'');
  const inferred=label.match(new RegExp('\\b('+currencyCodes.join('|')+')\\b','i'))?.[0].toUpperCase()||
   (/dolares|u\$s|us\$/.test(label)?'USD':/euros/.test(label)?'EUR':/pesos argentinos/.test(label)?'ARS':/reales/.test(label)?'BRL':/libras/.test(label)?'GBP':
    // "pesos" solo, sin otra nacionalidad, es ARS; "$" es la moneda de la familia.
    /\bpesos?\b/.test(label)&&!/pesos? (uruguayos|chilenos|mexicanos|colombianos)/.test(label)?'ARS':label==='$'?ctx.defaultCurrency:null);
  if(inferred!==currency)validationErrors.push('moneda explícita ambigua');
 }else if(explicitCurrency)validationErrors.push('moneda explícita sin resolver');
 if(explicitCurrency?.some(label=>currencyCode(label)!==currency))validationErrors.push('monedas explícitas contradictorias o sin resolver');
 if(!currencyCodes.includes(currency))validationErrors.push('moneda inválida');
 if(!raw.description)missingFields.push('descripción');
 if(raw.merchant&&!evidence(raw.merchant))validationErrors.push('comercio sin respaldo en el mensaje');
 let categoryId:string|null=null,cardId:string|null=null;
 if(!raw.category)missingFields.push('categoría');
 else{
  const found=ctx.categories.filter(c=>c.active&&normalizeName(c.name)===normalizeName(raw.category!));
  if(found.length!==1)validationErrors.push('categoría inexistente, inactiva o ambigua');else categoryId=found[0].id;
 }
 let paymentMethod=raw.paymentMethod;
 const bothCardKinds=/\bcredito\b/.test(normalizeName(ctx.text))&&/\bdebito\b/.test(normalizeName(ctx.text));
 const backed=evidence(raw.paymentMethodText)&&paymentEvidence(raw.paymentMethodText||'')===paymentMethod;
 // Sin ninguna palabra de pago en el texto, el medio del modelo es una suposición: se descarta (no se usa).
 if(paymentMethod&&!backed&&!bothCardKinds&&paymentEvidence(ctx.text)===null)paymentMethod=null;
 else if(paymentMethod&&(!backed||bothCardKinds))validationErrors.push('medio de pago sin respaldo o ambiguo');
 // A mentioned known card must not disappear from the interpretation.
 // Excepción: una "tarjeta" con nombre de billetera (ej. Mercado Pago) pagada como billetera.
 const mentionedCards=ctx.cards.filter(c=>normalizeName(ctx.text).includes(normalizeName(c.name))&&!(paymentMethod==='wallet'&&WALLET.test(normalizeName(c.name))));
 if(!raw.card&&(mentionedCards.length||/\b(visa|mastercard|amex)\b/i.test(ctx.text)))validationErrors.push('tarjeta mencionada sin resolver');
 if(raw.card){
  if(!evidence(raw.card))validationErrors.push('tarjeta sin respaldo en el mensaje');
  const n=normalizeName(raw.card);
  const found=ctx.cards.filter(c=>{const name=normalizeName(c.name);return name===n||name.startsWith(n+' ')||n.startsWith(name+' ');});
  let cardType:CardType|null=null;
  if(found.length!==1||!found[0].active)validationErrors.push('tarjeta inexistente, inactiva o ambigua');
  else{cardId=found[0].id;cardType=found[0].cardType;}
  // Crédito/débito sale del tipo configurado en la tarjeta, nunca del modelo.
  if(cardType&&!paymentMethod)paymentMethod=cardType;
  if(cardType&&paymentMethod!==cardType)validationErrors.push('el medio de pago no coincide con el tipo de la tarjeta');
  else if(!paymentMethod||!['credit_card','debit_card'].includes(paymentMethod))validationErrors.push('indicar crédito o débito para la tarjeta');
 }
 if(!paymentMethod)missingFields.push('medio de pago');
 if(!ctx.member.active)validationErrors.push('integrante no autorizado');
 const candidate:ExpenseCandidate={date,amount,currency,merchant:raw.merchant,description:raw.description,category:raw.category,paymentMethod,card:raw.card,reportedByMemberId:ctx.member.id,missingFields};
 let expense:ExpenseWrite|null=null;
 if(!missingFields.length&&!validationErrors.length){
  try{expense=validateExpenseWrite({date,amount,currency,merchant:raw.merchant,description:raw.description,categoryId,paymentMethod,cardId,reportedByMemberId:ctx.member.id});}
  catch{validationErrors.push('campos incompatibles con el modelo de gastos');}
 }
 return {candidate,valid:!!expense,missingFields,validationErrors,expense};
}
