
import {PAYMENT_CODES,type CardType,type ExpenseWrite,type PaymentCode} from '../../shared/apiTypes';
import {normalizeAmount,validateExpenseWrite} from '../expenses/validation';
import {isDateOnly} from '../../utils/finance';
import {QUESTION_ORDER,applyCandidatePatch,type DraftField,type DraftPatch,type ExpenseDraft} from './draft';

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
 // Solo durante una conversación: borrador actual (con nombres reales) y campo preguntado.
 conversation?:{draft:Record<string,string|null>;expectedField:DraftField|null};
}
// detail: código técnico sin datos del mensaje (ej. http_404), para diagnosticar sin adivinar.
export class InterpretationError extends Error {constructor(message:string,public detail?:string){super(message);}}
// Billeteras virtuales (QR o transferencia desde la app): nunca son tarjeta. Única lista; ampliar acá.
// Se registran como medio "wallet" sin identificar cuál billetera.
export const WALLET_NAMES=['billetera','mercado pago','mercadopago','mp','qr','brubank'] as const;
const WALLET=new RegExp('\\b('+WALLET_NAMES.join('|')+')\\b');
const keys=['amount','amountText','dateText','currency','currencyText','merchant','description','category','paymentMethod','paymentMethodText','card'] as const;
export function emptyInterpretation():Interpretation{
 return {amount:null,amountText:null,dateText:null,currency:null,currencyText:null,merchant:null,description:null,category:null,paymentMethod:null,paymentMethodText:null,card:null};
}
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
export function paymentEvidence(s:string):PaymentCode|null {
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
const CARD_METHODS:readonly PaymentCode[]=['credit_card','debit_card'];
// Tarjetas que pueden responder "¿Con qué tarjeta?" para un medio: activas de ese tipo o sin tipo definido.
export function eligibleCards(cards:CardEntry[],method:PaymentCode):CardEntry[]{
 return cards.filter(c=>c.active&&(c.cardType===method||c.cardType===null)).sort((a,b)=>a.name.localeCompare(b.name,'es'));
}

export interface PatchOptions {
 // strict: mensaje inicial; un dato sin respaldo es error. En conversación se descarta (puede ser eco del contexto).
 strict:boolean;
 expected?:DraftField|null;
}
export interface PatchResult {patch:DraftPatch;fieldErrors:Partial<Record<DraftField,string>>;errors:string[]}
// Nivel 1: valida lo que aporta UN mensaje contra la evidencia de ESE mensaje.
export function validatePatch(raw:Interpretation,ctx:InterpretationContext,draft:ExpenseDraft,options:PatchOptions):PatchResult{
 const patch:DraftPatch={},fieldErrors:PatchResult['fieldErrors']={},errors:string[]=[];
 const unsupported=(field:DraftField|null,message:string)=>{
  if(!options.strict)return;
  if(field)fieldErrors[field]??=message;else errors.push(message);
 };
 const evidence=(s:string|null)=>s!==null&&normalizeName(ctx.text).includes(normalizeName(s));
 const reference=draft.referenceDate;
 // Una fecha explícita reconocible no puede convertirse silenciosamente en la fecha de referencia.
 const explicitDates=[...ctx.text.matchAll(/\b(?:hoy|ayer|anteayer|mañana|lunes|martes|miércoles|jueves|viernes|sábado|domingo|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?: de \d{4})?)\b/gi)].map(match=>match[0]);
 let dateText=raw.dateText;
 if(dateText&&!evidence(dateText)){unsupported('date','fecha sin respaldo en el mensaje');dateText=options.strict?null:explicitDates[0]||null;}
 else dateText??=explicitDates[0]||null;
 if(dateText&&!fieldErrors.date){
  const date=resolveDate(dateText,reference);
  if(!date)fieldErrors.date='fecha inválida o ambigua';
  else if(explicitDates.some(fragment=>resolveDate(fragment,reference)!==date))fieldErrors.date='referencias de fecha contradictorias o sin resolver';
  else patch.date={value:date,evidence:dateText};
 }

 if(raw.amount!==null){
  let amount:string|null=null;
  try{amount=normalizeAmount(raw.amount);}catch{unsupported('amount','monto inválido');}
  if(amount!==null){
   if(!evidence(raw.amountText)||!amountEvidence(ctx.text,raw.amountText)||normalizeTextAmount(raw.amountText||'')!==amount)unsupported('amount','monto sin respaldo en el mensaje');
   else patch.amount={value:amount,evidence:raw.amountText};
  }
 }

 const currencyCodes=Intl.supportedValuesOf('currency');
 const explicitCurrency=ctx.text.match(new RegExp('\\b('+currencyCodes.join('|')+')\\b|d[oó]lares|u\\$s|us\\$|euros|pesos argentinos|reales|libras','gi'));
 const currencyCode=(value:string)=>{
  const label=normalizeName(value);
  return currencyCodes.includes(label.toUpperCase())?label.toUpperCase():
   label==='dolares'||label==='u$s'||label==='us$'?'USD':label==='euros'?'EUR':label==='pesos argentinos'?'ARS':label==='reales'?'BRL':label==='libras'?'GBP':null;
 };
 let currency:string|null=null;
 if(raw.currency!==null){
  if(!evidence(raw.currencyText))unsupported(null,'moneda sin respaldo en el mensaje');
  else{
   const label=normalizeName(raw.currencyText||'');
   const inferred=label.match(new RegExp('\\b('+currencyCodes.join('|')+')\\b','i'))?.[0].toUpperCase()||
    (/dolares|u\$s|us\$/.test(label)?'USD':/euros/.test(label)?'EUR':/pesos argentinos/.test(label)?'ARS':/reales/.test(label)?'BRL':/libras/.test(label)?'GBP':
     // "pesos" solo, sin otra nacionalidad, es ARS; "$" es la moneda de la familia.
     /\bpesos?\b/.test(label)&&!/pesos? (uruguayos|chilenos|mexicanos|colombianos)/.test(label)?'ARS':label==='$'?ctx.defaultCurrency:null);
   if(inferred!==raw.currency)errors.push('moneda explícita ambigua');
   else if(!currencyCodes.includes(raw.currency))errors.push('moneda inválida');
   else currency=raw.currency;
  }
 }
 if(currency===null&&explicitCurrency)errors.push('moneda explícita sin resolver');
 const effectiveCurrency=currency??draft.currency?.value??ctx.defaultCurrency;
 if(explicitCurrency?.some(label=>currencyCode(label)!==effectiveCurrency))errors.push('monedas explícitas contradictorias o sin resolver');
 if(currency&&!errors.length)patch.currency={value:currency,evidence:raw.currencyText};

 // La descripción es un resumen del mensaje inicial; en conversación solo completa una faltante.
 if(raw.description&&(options.strict||!draft.description))patch.description={value:raw.description.trim(),evidence:null};
 if(raw.merchant){
  if(evidence(raw.merchant))patch.merchant={value:raw.merchant.trim(),evidence:raw.merchant};
  else unsupported(null,'comercio sin respaldo en el mensaje');
 }
 // En conversación la IA no reclasifica una categoría ya cargada salvo que el usuario la nombre.
 if(raw.category&&(options.strict||!draft.category||options.expected==='category'||evidence(raw.category))){
  const found=ctx.categories.filter(c=>c.active&&normalizeName(c.name)===normalizeName(raw.category!));
  if(found.length!==1)fieldErrors.category='categoría inexistente, inactiva o ambigua';
  else patch.category={value:found[0].id,evidence:raw.category};
 }

 let paymentMethod=raw.paymentMethod;
 const bothCardKinds=/\bcredito\b/.test(normalizeName(ctx.text))&&/\bdebito\b/.test(normalizeName(ctx.text));
 const backed=evidence(raw.paymentMethodText)&&paymentEvidence(raw.paymentMethodText||'')===paymentMethod;
 // Sin ninguna palabra de pago en el texto, el medio del modelo es una suposición: se descarta (no se usa).
 if(paymentMethod&&!backed&&!bothCardKinds&&paymentEvidence(ctx.text)===null)paymentMethod=null;
 else if(paymentMethod&&(!backed||bothCardKinds)){fieldErrors.paymentMethod='medio de pago sin respaldo o ambiguo';paymentMethod=null;}
 if(paymentMethod)patch.paymentMethod={value:paymentMethod,evidence:raw.paymentMethodText};
 const method=()=>patch.paymentMethod?.value??draft.paymentMethod?.value??null;

 // Una tarjeta mencionada no puede desaparecer de la interpretación.
 // Excepción: una "tarjeta" con nombre de billetera (ej. Mercado Pago) pagada como billetera.
 const mentionedCards=ctx.cards.filter(c=>normalizeName(ctx.text).includes(normalizeName(c.name))&&!(method()==='wallet'&&WALLET.test(normalizeName(c.name))));
 if(!raw.card&&(mentionedCards.length||/\b(visa|mastercard|amex)\b/i.test(ctx.text)))fieldErrors.card='tarjeta mencionada sin resolver';
 if(raw.card){
  if(!evidence(raw.card))unsupported('card','tarjeta sin respaldo en el mensaje');
  else{
   const n=normalizeName(raw.card);
   const matches=ctx.cards.filter(c=>{const name=normalizeName(c.name);return name===n||name.startsWith(n+' ')||n.startsWith(name+' ');});
   let active=matches.filter(c=>c.active);
   // Varias tarjetas con el mismo nombre de marca: decide el tipo indicado (crédito/débito). Nunca la primera.
   const typed=active.filter(c=>c.cardType!==null&&c.cardType===method());
   if(active.length>1&&typed.length===1)active=typed;
   if(active.length!==1)fieldErrors.card=active.length>1?'tarjeta ambigua':'tarjeta inexistente o inactiva';
   else{
    const card=active[0],current=method();
    // Crédito/débito sale del tipo configurado en la tarjeta, nunca del modelo.
    if(card.cardType&&current&&current!==card.cardType){fieldErrors.paymentMethod='el medio de pago no coincide con el tipo de la tarjeta';delete patch.paymentMethod;}
    else if(!card.cardType&&current&&!CARD_METHODS.includes(current)){fieldErrors.paymentMethod='indicar crédito o débito para la tarjeta';delete patch.paymentMethod;}
    else{
     if(card.cardType&&!current)patch.paymentMethod={value:card.cardType,evidence:raw.card};
     if(!card.cardType&&!current)fieldErrors.paymentMethod='indicar crédito o débito para la tarjeta';
     patch.card={value:card.id,evidence:raw.card};
    }
   }
  }
 }
 if(!ctx.member.active)errors.push('integrante no autorizado');
 return {patch,fieldErrors,errors};
}

export interface DraftValidation {valid:boolean;missingFields:DraftField[];validationErrors:string[];expense:ExpenseWrite|null}
// Nivel 2: valida el borrador combinado contra las reglas del gasto y los catálogos activos actuales.
export function validateDraft(draft:ExpenseDraft,ctx:Pick<InterpretationContext,'categories'|'cards'|'defaultCurrency'|'member'>):DraftValidation{
 const missing=new Set<DraftField>(),errors:string[]=[];
 const require=new Set(draft.require||[]);
 if(!draft.amount)missing.add('amount');
 const method=draft.paymentMethod?.value??null;
 if(!method)missing.add('paymentMethod');
 let cardId:string|null=null;
 if(method&&CARD_METHODS.includes(method)){
  if(draft.card===undefined){
   // Se pregunta si hay tarjetas activas utilizables o si el usuario nombró una que no se pudo usar.
   if(require.has('card')||eligibleCards(ctx.cards,method).length)missing.add('card');
  }else if(draft.card.value!==null){
   const card=ctx.cards.find(c=>c.id===draft.card!.value);
   if(!card?.active){errors.push('tarjeta inexistente o inactiva');missing.add('card');}
   else if(card.cardType&&card.cardType!==method){errors.push('el medio de pago no coincide con el tipo de la tarjeta');missing.add('card');}
   else cardId=card.id;
  }
 }
 let categoryId:string|null=null,categoryName:string|null=null;
 if(!draft.category)missing.add('category');
 else{
  const category=ctx.categories.find(c=>c.id===draft.category!.value&&c.active);
  if(!category){errors.push('categoría inexistente o inactiva');missing.add('category');}
  else{categoryId=category.id;categoryName=category.name;}
 }
 if(require.has('date')&&!draft.date)missing.add('date');
 if(!ctx.member.active)errors.push('integrante no autorizado');
 const merchant=draft.merchant?.value??null;
 // La descripción nunca se pregunta: si falta se deriva del comercio o de la categoría.
 const description=draft.description?.value??(merchant?'Compra en '+merchant:categoryName?'Gasto en '+categoryName:null);
 const missingFields=QUESTION_ORDER.filter(f=>missing.has(f));
 let expense:ExpenseWrite|null=null;
 if(!missingFields.length&&!errors.length){
  try{expense=validateExpenseWrite({date:draft.date?.value??draft.referenceDate,amount:draft.amount!.value,currency:draft.currency?.value??ctx.defaultCurrency,merchant,description,categoryId,paymentMethod:method,cardId,reportedByMemberId:ctx.member.id,scope:draft.scope??'personal'});
   // Corregir un gasto guardado no le asigna ámbito: conserva el que tenía (aunque sea "sin clasificar").
   if(draft.editingExpenseId&&!draft.scope)delete expense.scope;}
  catch{errors.push('campos incompatibles con el modelo de gastos');}
 }
 return {valid:!!expense,missingFields,validationErrors:errors,expense};
}

export const FIELD_LABELS:Record<DraftField,string>={amount:'monto',paymentMethod:'medio de pago',card:'tarjeta',category:'categoría',date:'fecha'};
// Un mensaje completo: parche estricto sobre un borrador vacío + validación del borrador.
export function validateExpenseCandidate(raw:Interpretation,ctx:InterpretationContext){
 const empty:ExpenseDraft={referenceDate:ctx.referenceDate};
 const patched=validatePatch(raw,ctx,empty,{strict:true});
 const draft=applyCandidatePatch(empty,patched.patch,Object.keys(patched.fieldErrors) as DraftField[]);
 const result=validateDraft(draft,ctx);
 const validationErrors=[...patched.errors,...Object.values(patched.fieldErrors) as string[],...result.validationErrors];
 const missingFields=result.missingFields.map(f=>FIELD_LABELS[f]);
 const valid=result.valid&&!validationErrors.length;
 const card=draft.card?.value?ctx.cards.find(c=>c.id===draft.card!.value)?.name??null:null;
 const candidate:ExpenseCandidate={date:draft.date?.value??draft.referenceDate,amount:draft.amount?.value??null,currency:draft.currency?.value??ctx.defaultCurrency,
  merchant:draft.merchant?.value??null,description:result.expense?.description??draft.description?.value??null,
  category:raw.category,paymentMethod:draft.paymentMethod?.value??null,card,reportedByMemberId:ctx.member.id,missingFields};
 return {candidate,valid,missingFields,validationErrors,expense:valid?result.expense:null,patched,draft,result};
}
