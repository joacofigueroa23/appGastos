import {normalizeName,normalizeTextAmount,paymentEvidence,resolveDate} from '../whatsapp/candidate';
import type {PaymentCode} from '../../shared/apiTypes';
import type {DocumentKind,DraftItem,ReceiptDraft} from './types';
// Comandos de texto sobre un comprobante pendiente. Se reconocen por reglas (no por Gemini): son determinísticos y corregir un
// borrador no vuelve a llamar al modelo. Un mensaje que no encaja en ninguna forma NO es un comando y sigue su camino normal.
export type Command=
 |{type:'ticketCategory';category:string}|{type:'undo'}|{type:'unsettle'}|{type:'configList';kind:'budget'|'fixed'}|{type:'confirm';code?:string}|{type:'cancel';code?:string}|{type:'scope';value:'personal'|'household'}
 |{type:'date';raw:string}|{type:'total';raw:string}|{type:'payment';value:PaymentCode}|{type:'noExpense'}|{type:'expense'}|{type:'link'}|{type:'unlink'}
 |{type:'kind';value:DocumentKind}|{type:'exclude';item:string}|{type:'itemCategory';item:string;category:string};
const clean=(text:string)=>normalizeName(text).replace(/[.,;:!¡?¿"'«»]/g,' ').replace(/\s+/g,' ').trim();
// Fecha e importe conservan . , / : la puntuación limpia convertiría «19.000» en «19 000».
const keepPunctuation=(text:string)=>normalizeName(text).replace(/[¡!¿?"'«»]/g,'').trim();
const CODE='([a-z0-9]{4})';
export function parseCommand(text:string):Command|null{
 const t=clean(text);let m:RegExpExecArray|null;
 if((m=new RegExp('^(?:confirmar|confirmo|confirmado|si|ok|dale|listo|registrar|registralo|guardar|guardalo|aceptar)(?: '+CODE+')?$').exec(t)))return {type:'confirm',code:m[1]};
 if((m=new RegExp('^(?:cancelar|cancela|descartar|descarta|descartalo|no)(?: '+CODE+')?$').exec(t)))return {type:'cancel',code:m[1]};
 if(/^(?:deshacer|deshacelo|deshace|anular|anulalo)(?: (?:el )?(?:ultimo|registro))?$/.test(t))return {type:'undo'};
 if(/^(?:es |gasto )?(?:de la casa|del hogar|casa)$/.test(t))return {type:'scope',value:'household'};
 if(/^(?:es |gasto )?personal$/.test(t))return {type:'scope',value:'personal'};
 if((m=/^(?:con |pague con |fue con |es )?(efectivo|debito|credito|transferencia|billetera|mercado pago)$/.exec(t))){const value=paymentEvidence(m[1]);if(value)return {type:'payment',value};}
 const raw=keepPunctuation(text);
 if((m=/^(?:la )?fecha(?: es| fue)?:? (.+)$/.exec(raw)))return {type:'date',raw:m[1]};
 if((m=/^(?:el )?total(?: es| fue)?:? (.+)$/.exec(raw)))return {type:'total',raw:m[1]};
 if(/^no es (?:un )?gasto$|^es una transferencia propia$/.test(t))return {type:'noExpense'};
 if((m=/^(?:todo|todos|el ticket|este ticket|la compra|toda la compra|todo el ticket|el pago|este pago)(?: va| es| son| van)? (?:en|de|como|a) (?:la |el |los |las )?(.+)$/.exec(t)))return {type:'ticketCategory',category:m[1]};
 if(/^(?:es |son |esta es |estos son |esto es |era |eran )?(?:una |un |mi |mis |la |el |las |los )?(?:lista de |listado de )?presupuestos?(?: mensuales?)?$/.test(t))return {type:'configList',kind:'budget'};
 if(/^(?:es |son |esta es |estos son |esto es |era |eran )?(?:una |un |mi |mis |la |el |las |los )?(?:lista de |listado de )?gastos fijos?$/.test(t))return {type:'configList',kind:'fixed'};
 if(/^(?:no saldar|no es (?:el )?gasto fijo|no es del gasto fijo|no es una obligacion)$/.test(t))return {type:'unsettle'};
 if(/^(?:no vincular|crear nuevo|nuevo gasto|es un gasto nuevo)$/.test(t))return {type:'unlink'};
 if(/^(?:vincular|vinculalo|asociar|asocialo|es el mismo|ya lo cargue|ya esta cargado|ya lo tengo cargado)$/.test(t))return {type:'link'};
 if(/^es gasto$/.test(t))return {type:'expense'};
 if((m=/^(?:es |son )?(?:un |una )?(ticket|factura|comprobante de pago|comprobante|resumen)$/.exec(t))){
  const map:Record<string,DocumentKind>={ticket:'purchase_receipt',factura:'pending_invoice','comprobante de pago':'payment_receipt',comprobante:'payment_receipt',resumen:'card_statement'};
  return {type:'kind',value:map[m[1]]};
 }
 if((m=/^(?:quitar|excluir|sacar|saca|saque|borrar|elimina|eliminar)(?: el| la| los| las)? (.+)$/.exec(t)))return {type:'exclude',item:m[1]};
 if((m=/^(?:el |la |los |las )?(.+?) (?:va |van |es |son |ponelo |ponela |pone )?(?:en|como|a) (?:la |el |los |las )?(.+)$/.exec(t)))return {type:'itemCategory',item:m[1],category:m[2]};
 return null;
}
// Concepto del borrador al que se refiere el usuario: coincidencia exacta o única por contenido. Ambiguo o inexistente → null.
export function findItem(draft:ReceiptDraft,ref:string):DraftItem|null{
 const r=normalizeName(ref).replace(/^(?:el|la|los|las) /,'');
 const real=draft.items.filter(i=>!i.adjustment);
 const exact=real.filter(i=>normalizeName(i.description)===r);
 if(exact.length===1)return exact[0];
 const part=real.filter(i=>{const d=normalizeName(i.description);return d.includes(r)||r.includes(d);});
 return part.length===1?part[0]:null;
}
export function findCategory(categories:{id:string;name:string;active:boolean}[],ref:string):{id:string;name:string}|null{
 const r=normalizeName(ref),active=categories.filter(c=>c.active);
 const exact=active.filter(c=>normalizeName(c.name)===r);
 if(exact.length===1)return exact[0];
 const part=active.filter(c=>normalizeName(c.name).includes(r)||normalizeName(c.name).split(/[^a-z0-9]+/).includes(r));
 return part.length===1?part[0]:null;
}
export const parseAmountText=(raw:string)=>normalizeTextAmount(raw);
// Un ticket no es del futuro: si el día y mes sin año caen después de hoy, se toma el año anterior ("fecha 28/12" dicho en enero).
export function parseDateText(raw:string,today:string):string|null{
 const date=resolveDate(raw,today);
 if(!date||date<=today||/\d{4}/.test(raw))return date;
 return (Number(date.slice(0,4))-1)+date.slice(4);
}
