import type {PaymentCode} from '../../shared/apiTypes';
import {eligibleCards,type CardEntry,type CatalogEntry} from './candidate';
import type {DraftField,ExpenseDraft} from './draft';

// Plantillas deterministas de WhatsApp. Sin IA generativa.

// Monto con formato argentino: $35.000, $1.234,56; otra moneda con prefijo explícito (US$ 100, EUR 50).
export function formatAmount(amount:string,currency:string,familyCurrency:string):string{
 const [whole,decimals='00']=amount.split('.');
 const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
 const n=/^0*$/.test(decimals)?grouped:grouped+','+decimals.padEnd(2,'0');
 return currency===familyCurrency?'$'+n:currency==='USD'?'US$ '+n:currency+' '+n;
}

export interface Question {text:string;options?:(string|null)[]}
const numbered=(names:string[])=>names.map((name,i)=>(i+1)+') '+name).join('  ');
// Pregunta para el primer campo faltante. Las listas guardan los ids en el orden mostrado.
export function questionFor(field:DraftField,draft:ExpenseDraft,catalog:{categories:CatalogEntry[];cards:CardEntry[]}):Question{
 switch(field){
  case 'amount':return {text:'¿Cuánto gastaste?'};
  case 'paymentMethod':return {text:'¿Cómo pagaste? Efectivo, débito, crédito, transferencia o billetera virtual.'};
  case 'card':{
   const method=draft.paymentMethod?.value;
   const cards=method?eligibleCards(catalog.cards,method as PaymentCode):[];
   return {text:'¿Con qué tarjeta? '+numbered([...cards.map(c=>c.name),'Ninguna']),options:[...cards.map(c=>c.id),null]};
  }
  case 'category':{
   const categories=catalog.categories.filter(c=>c.active).sort((a,b)=>a.name.localeCompare(b.name,'es'));
   return {text:'¿En qué categoría lo cargo? '+numbered(categories.map(c=>c.name)),options:categories.map(c=>c.id)};
  }
  case 'date':return {text:'¿Qué día fue? (ej. hoy, ayer, 12/10)'};
 }
}

export function confirmation(input:{amount:string;currency:string;familyCurrency:string;merchant:string|null;categoryName:string;cardName:string|null;edited?:boolean}):string{
 const where=input.merchant?input.merchant+' · '+input.categoryName:input.categoryName;
 return (input.edited?'✏️ Corregido: ':'✅ Registrado: ')+formatAmount(input.amount,input.currency,input.familyCurrency)+' en '+where+(input.cardName?' · '+input.cardName:'')+'.';
}
// Resumen breve del borrador para el aviso de gasto pendiente.
export function draftSummary(draft:ExpenseDraft,catalog:{categories:CatalogEntry[]},familyCurrency:string):string{
 const parts:string[]=[];
 if(draft.amount)parts.push(formatAmount(draft.amount.value,draft.currency?.value??familyCurrency,familyCurrency));
 const category=draft.category?catalog.categories.find(c=>c.id===draft.category!.value)?.name:null;
 if(draft.merchant)parts.push('en '+draft.merchant.value);else if(category)parts.push('en '+category);
 return parts.length?parts.join(' '):'sin datos todavía';
}
const PLAIN:[RegExp,string][]=[[/fecha/,'la fecha'],[/monto|importe/,'el importe'],[/categor/,'la categoría'],[/medio de pago/,'el medio de pago'],[/tarjeta/,'la tarjeta'],[/moneda/,'la moneda'],[/comercio/,'el comercio']];
// Errores de campo convertidos en un aviso previo a la pregunta.
export function fieldNotice(errors:string[]):string{
 if(!errors.length)return '';
 // Lo técnico («fecha inválida o ambigua») se dice en cristiano: «No entendí bien la fecha».
 const unique=[...new Set(errors)],plain:string[]=[],raw:string[]=[];
 for(const e of unique){
  const unclear=/(ambigu|inv\u00e1lid|invalid|sin respaldo|inexistente|inactiv)/.test(e);
  const what=PLAIN.find(([r])=>r.test(e))?.[1];
  if(unclear&&what)plain.push(what);else raw.push(e);
 }
 return (plain.length?'No entendí bien '+[...new Set(plain)].join(', ')+'. ':'')+(raw.length?'No pude tomar: '+raw.join('; ')+'. ':'');
}

export const REPLIES={
 cancelled:'Listo, cancelé el gasto pendiente. No se registró nada.',
 cancelledEdit:'Listo, cancelé la corrección. El gasto quedó como estaba.',
 correctionUnclear:(summary:string)=>'No entendí qué corregir del último gasto ('+summary+'). Decime el dato correcto, por ejemplo: "perdón, fueron 45 mil".',
 editGone:'No pude corregir el gasto: ya no existe o una referencia dejó de estar disponible. ',
 nothingToCancel:'No tenés ningún gasto pendiente para cancelar.',
 conflict:(summary:string)=>'Tenés un gasto pendiente ('+summary+'). Respondé la pregunta o escribí "cancelar" para empezar otro.',
 unknown:'No te entendí bien. ',
 tooManyUnknown:'No pude entender las respuestas, así que cancelé el gasto pendiente. No se registró nada. Podés empezar de nuevo cuando quieras.',
 corrected:'Corregido. ',
 help:'Contame tu gasto con el monto, el lugar y cómo pagaste (ej: "Gasté 35 mil en Carrefour con débito"), o mandame una foto de un ticket o una factura. También podés preguntarme cuánto gastaste este mes.',
 notInterpreted:'No pude entender ese mensaje. ',
 unavailable:'El servicio de interpretación no está disponible ahora. ',
 keptDraft:'El gasto pendiente sigue guardado. ',
 notRegistered:'No se registró ningún gasto; ',
 failed:'No pude procesar tu mensaje. Intenta de nuevo con otro texto o usa la carga manual.',
 unsupported:'Por ahora entiendo texto, fotos y PDF. Los audios y otros archivos todavía no los puedo leer.',
 unauthorized:'Este número no está vinculado a un integrante de la familia. Si ya tenés cuenta, generá un código en Mi perfil y enviá: VINCULAR <código>.',
 linked:'Listo, vinculé este número con tu cuenta. Desde ahora tus gastos quedan a tu nombre.',
 linkInvalid:'El código no es válido o venció. Generá uno nuevo en Mi perfil y enviá: VINCULAR <código>.',
 linkAlready:'Este número ya está vinculado a una cuenta.',
 linkLocked:'Demasiados intentos fallidos. Esperá una hora y generá un código nuevo en Mi perfil.',
 noLongerAuthorized:'Este número ya no está autorizado. No se registró el gasto.',
 referenceGone:'No registré el gasto: una referencia dejó de estar disponible. ',
};
