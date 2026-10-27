import type {DraftItem,MoneyLine,ReceiptDraft} from './types';
// Importes en centavos enteros: nunca coma flotante. Los importes viajan como texto decimal ("1234.56").
export const toCents=(value:string):number=>{
 const negative=value.startsWith('-'),[whole,dec='']=value.replace('-','').split('.');
 const cents=Number(whole)*100+Number(dec.padEnd(2,'0').slice(0,2));
 return negative?-cents:cents;
};
export const fromCents=(cents:number):string=>(cents<0?'-':'')+Math.floor(Math.abs(cents)/100)+'.'+String(Math.abs(cents)%100).padStart(2,'0');
const sum=(lines:{amount:string}[])=>lines.reduce((n,l)=>n+toCents(l.amount),0);
export interface Adjustment {description:string;amount:string;explained:boolean;auto?:boolean}
// Concilia los conceptos incluidos con el total del comprobante SIN modificar el total.
// La diferencia (descuentos, recargos, impuestos no incluidos, redondeo, error de lectura) queda como partidas de ajuste visibles,
// con su importe con signo, que el usuario clasifica. Invariante: suma de conceptos + suma de ajustes = total.
export function reconcile(included:{amount:string}[],total:string|null,c:{discounts:MoneyLine[];taxes:MoneyLine[];surcharges:MoneyLine[];taxesIncluded:boolean;rounding?:string|null}):Adjustment[]{
 if(total===null)return [];
 const diff=toCents(total)-sum(included);
 if(diff===0)return [];
 // Impuestos "incluidos" ya están en el precio de los conceptos o del total: no se suman otra vez.
 const parts:Adjustment[]=[
  ...c.discounts.map(d=>({description:'Descuento: '+d.description,amount:fromCents(-toCents(d.amount)),explained:true,auto:true})),
  ...c.surcharges.map(d=>({description:'Recargo: '+d.description,amount:d.amount,explained:true,auto:true})),
  ...(c.taxesIncluded?[]:c.taxes.map(d=>({description:'Impuesto: '+d.description,amount:d.amount,explained:true,auto:true}))),
  ...(c.rounding&&toCents(c.rounding)!==0?[{description:'Redondeo',amount:c.rounding,explained:true,auto:true}]:[]),
 ];
 if(parts.length&&sum(parts)===diff)return parts;
 // Una diferencia menor a una unidad de moneda (ej. -0,32) es redondeo, aunque el comprobante no lo diga: no hace falta preguntar.
 if(Math.abs(diff)<=100)return [{description:'Redondeo',amount:fromCents(diff),explained:true,auto:true}];
 return [{description:'Diferencia sin explicar',amount:fromCents(diff),explained:false,auto:true}];
}
const ADJUSTMENT_ID=1000;
// Recalcula las partidas de ajuste de un borrador. Conserva la categoría que el usuario ya les asignó (por descripción).
// Todo ajuste (IVA, redondeo, descuento, diferencia) forma parte del total del ticket y toma su categoría (la de mayor importe) mientras el usuario no elija otra: no se pregunta.
export function recompute(draft:ReceiptDraft):ReceiptDraft{
 const real=draft.items.filter(i=>!i.adjustment),previous=new Map(draft.items.filter(i=>i.adjustment).map(i=>[i.description,i]));
 const included=real.filter(i=>!i.excluded),primary=primaryCategory(included);
 const adjustments:DraftItem[]=reconcile(included,draft.total,draft.components).map((a,n)=>{
  const prev=previous.get(a.description),manual=!!prev?.categoryId&&!prev.auto;
  const categoryId=manual?prev!.categoryId:a.auto?primary:null;
  return {id:ADJUSTMENT_ID+n,description:a.description,amount:a.amount,categoryId,excluded:false,adjustment:true,...(a.auto&&!manual?{auto:true}:{})};
 });
 return {...draft,items:[...real,...adjustments]};
}
export const includedItems=(draft:ReceiptDraft)=>draft.items.filter(i=>!i.excluded);
// Categoría principal de un gasto con conceptos: la de mayor importe (para mostrar y filtrar). El consumo usa los conceptos.
export function primaryCategory(items:{categoryId:string|null;amount:string}[]):string|null{
 const totals=new Map<string,number>();
 for(const i of items)if(i.categoryId)totals.set(i.categoryId,(totals.get(i.categoryId)||0)+toCents(i.amount));
 let best:string|null=null;
 for(const [id,cents] of totals)if(best===null||cents>totals.get(best)!)best=id;
 return best;
}
