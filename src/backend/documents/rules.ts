import type {Connection} from '../expenses/repository';
import {normalizeName} from '../whatsapp/candidate';
import type {DraftContext} from './draft';
import {includedItems} from './reconcile';
import type {ReceiptDraft} from './types';
// Categorización asistida. Una regla se aprende SOLO de una categoría que el usuario eligió o corrigió y luego confirmó. Una regla sola nunca registra
// nada: rellena la categoría de un ticket de compra (el usuario la ve en el resumen y puede cambiarla) o la ofrece como sugerencia.
// Nombres genéricos o de personas («Brenda», «pago», «transferencia») no sirven como clave permanente: un payment_receipt solo recibe sugerencias.
const GENERIC=new Set(['pago','pagos','compra','compras','transferencia','mercado pago','mercadopago','mp','qr','efectivo','varios','otros','comprobante','ticket','factura','sin nombre']);
export function ruleKey(name:string|null):string|null{
 if(!name)return null;
 const k=normalizeName(name).replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
 return k.length>=3&&k.length<=80&&!GENERIC.has(k)?k:null;
}
interface Rule {id:string;member_id:string|null;key:string;category_id:string;hits:number}
async function matching(db:Connection,family:string,member:string,key:string):Promise<Rule[]>{
 // Primero la personal del integrante, después la de la familia.
 return (await db.query('SELECT id,member_id,key,category_id,hits FROM appgastos.category_rules WHERE family_id=$1 AND key=$2 AND (member_id IS NULL OR member_id=$3) ORDER BY (member_id IS NULL),hits DESC',[family,key,member])).rows;
}
const MAX_SUGGESTIONS=3;
// Hasta tres categorías para ofrecer: las de reglas del comercio y, para completar, las que más usó este integrante en los últimos 90 días.
export async function suggestCategories(db:Connection,family:string,member:string,merchant:string|null,ctx:DraftContext):Promise<string[]>{
 const active=new Set(ctx.categories.filter(c=>c.active).map(c=>c.id)),out:string[]=[];
 const add=(id:string)=>{if(active.has(id)&&!out.includes(id)&&out.length<MAX_SUGGESTIONS)out.push(id);};
 const key=ruleKey(merchant);
 if(key)for(const r of await matching(db,family,member,key))add(r.category_id);
 const used=(await db.query("SELECT category_id FROM appgastos.expenses WHERE family_id=$1 AND reported_by_member_id=$2 AND date>=current_date-90 AND category_id IS NOT NULL GROUP BY category_id ORDER BY count(*) DESC LIMIT 6",[family,member])).rows;
 for(const u of used)add(u.category_id);
 return out;
}
// Compra con un comercio ya conocido: la categoría aprendida entra sola (si el ticket no trae una) y queda avisado en el resumen.
export async function applyRules(db:Connection,family:string,member:string,draft:ReceiptDraft,ctx:DraftContext):Promise<ReceiptDraft>{
 const key=draft.kind==='purchase_receipt'?ruleKey(draft.merchant):null;
 const real=draft.items.filter(i=>!i.adjustment);
 if(!key||!real.length||real.some(i=>i.categoryId))return draft;
 const rule=(await matching(db,family,member,key)).find(r=>ctx.categories.some(c=>c.id===r.category_id&&c.active));
 if(!rule)return draft;
 const name=ctx.categories.find(c=>c.id===rule.category_id)!.name;
 return {...draft,items:draft.items.map(i=>i.adjustment?i:{...i,categoryId:rule.category_id,auto:true}),notes:[...draft.notes,'Usé «'+name+'» porque así categorizaste las compras en '+draft.merchant+'. Si no va ahí, decime la categoría.'].slice(0,8)};
}
// Aprende de lo que el usuario eligió. Solo un ticket de UNA categoría y con un comercio utilizable. Gasto de la casa → regla de la familia; si no, personal.
export async function learnFromConfirmation(db:Connection,family:string,member:string,draft:ReceiptDraft):Promise<void>{
 if(!draft.categoryByUser)return;
 const key=ruleKey(draft.merchant),cats=new Set(includedItems(draft).filter(i=>!i.adjustment).map(i=>i.categoryId));
 if(!key||cats.size!==1||![...cats][0])return;
 const owner=draft.scope==='household'?null:member;
 await db.query(`INSERT INTO appgastos.category_rules(family_id,member_id,key,category_id) VALUES($1,$2,$3,$4)
  ON CONFLICT (family_id,COALESCE(member_id,'00000000-0000-0000-0000-000000000000'::uuid),key)
  DO UPDATE SET hits=CASE WHEN category_rules.category_id=EXCLUDED.category_id THEN category_rules.hits+1 ELSE 1 END,category_id=EXCLUDED.category_id,updated_at=now()`,[family,owner,key,[...cats][0]]);
}
// Revisión: el administrador ve y borra reglas de la familia y las suyas; un integrante, solo las suyas.
export async function listRules(db:Connection,family:string,member:{id:string;role:'admin'|'member'},ctx:DraftContext):Promise<string>{
 const rows=(await db.query('SELECT key,category_id,hits,member_id FROM appgastos.category_rules WHERE family_id=$1 AND (member_id=$2 OR (member_id IS NULL AND $3)) ORDER BY hits DESC,key LIMIT 30',[family,member.id,member.role==='admin'])).rows;
 if(!rows.length)return 'Todavía no aprendí ninguna categoría de comercios. Se arman solas cuando elegís una categoría y confirmás.';
 return 'Esto aprendí:\n'+rows.map(r=>'• '+r.key+' → '+(ctx.categories.find(c=>c.id===r.category_id)?.name??'—')+(r.member_id?'':' (familia)')).join('\n')+'\nPara olvidar una: «olvidá la regla de '+rows[0].key+'».';
}
export async function forgetRule(db:Connection,family:string,member:{id:string;role:'admin'|'member'},name:string):Promise<string>{
 const key=ruleKey(name);
 const r=key?await db.query('DELETE FROM appgastos.category_rules WHERE family_id=$1 AND key=$2 AND (member_id=$3 OR (member_id IS NULL AND $4)) RETURNING id',[family,key,member.id,member.role==='admin']):null;
 return r?.rowCount?'Listo, me olvidé de lo que sabía de «'+name+'».':'No tengo ninguna regla de «'+name+'» que puedas borrar.';
}
