import {normalizeName} from '../whatsapp/candidate';
import type {DocumentKind,Extraction} from './types';
// La intención explícita del usuario pesa más que la clasificación del modelo. Del texto que acompaña a la foto o al PDF solo se guarda
// una etiqueta cerrada (no el texto): «Estos son mis presupuestos» → budget, «Pagué el colegio» → payment, etc.
export type IntentHint='budget'|'fixed'|'purchase'|'payment'|'invoice'|'statement';
export const HINTS:readonly IntentHint[]=['budget','fixed','purchase','payment','invoice','statement'];
export function captionHint(caption:string|null|undefined):IntentHint|null{
 const t=normalizeName(caption??'').replace(/[.,;:!?¡¿"']/g,' ').replace(/\s+/g,' ').trim();
 if(!t)return null;
 if(/\bpresupuestos?\b/.test(t))return 'budget';
 if(/\bgastos? fijos?\b|\bobligaciones\b|\bvencimientos\b/.test(t))return 'fixed';
 if(/\bresumen\b/.test(t))return 'statement';
 if(/\b(factura|boleta)\b/.test(t))return 'invoice';
 if(/\b(pague|pagamos|pago|pagado|transferi|transferencia|comprobante)\b/.test(t))return 'payment';
 if(/\b(compre|compramos|ticket|super|supermercado)\b/.test(t))return 'purchase';
 return null;
}
export const HINT_LABEL:Record<IntentHint,string>={budget:'una lista de presupuestos',fixed:'una lista de gastos fijos',purchase:'un ticket de compra',payment:'un comprobante de pago',invoice:'una factura',statement:'un resumen de tarjeta'};
const KIND:Record<Exclude<IntentHint,'budget'|'fixed'>,DocumentKind>={purchase:'purchase_receipt',payment:'payment_receipt',invoice:'pending_invoice',statement:'card_statement'};
// Líneas de una lista de presupuestos / gastos fijos. Si el modelo no completó configList pero leyó conceptos o consumos con importe, se usan esos.
export function listFromExtraction(e:Extraction,kind:'budget'|'fixed'):{name:string;amount:string|null;dueDay:number|null;category:string|null}[]{
 if(e.configList.kind===kind&&e.configList.items.length)return e.configList.items;
 if(e.configList.items.length)return e.configList.items;
 const fromItems=e.items.filter(i=>i.amount).map(i=>({name:i.description,amount:i.amount,dueDay:null,category:i.category}));
 if(fromItems.length)return fromItems;
 return e.lines.filter(l=>l.amount&&!l.amount.startsWith('-')).map(l=>({name:l.merchant,amount:l.amount,dueDay:null,category:l.category}));
}
// Aplica la intención explícita a lo que leyó el modelo. Devuelve la extracción ajustada (los comprobantes) o null cuando es una lista de configuración.
export function applyHint(e:Extraction,hint:IntentHint|null):{extraction:Extraction;list:'budget'|'fixed'|null}{
 if(!hint)return {extraction:e,list:e.configList.kind&&e.configList.items.length?e.configList.kind:null};
 if(hint==='budget'||hint==='fixed')return {extraction:e,list:hint};
 // Lo que el usuario afirma pesa más que la clasificación del modelo; nunca se inventa que algo esté pagado.
 const kind=KIND[hint];
 return {extraction:{...e,documentType:kind,configList:{kind:null,items:[]},paymentStatus:kind==='purchase_receipt'||kind==='payment_receipt'?'unknown':e.paymentStatus},list:null};
}
