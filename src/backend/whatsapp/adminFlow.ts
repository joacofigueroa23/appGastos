import type {Pool} from 'pg';
import {normalizeName,referenceDate} from './candidate';
import {answerToAsk,mergeIntent,prepareAdminAction,type StoredAction} from './admin';
import {looksLikeAdminRequest,type AdminContext,type AdminInterpreter} from './adminIntent';
// Ruta de un mensaje de TEXTO de un administrador hacia la configuración conversacional. Devuelve la respuesta o null (no era para esto).
//  1) Si hay un pedido "juntando datos" (el bot hizo una pregunta), el mensaje es la respuesta: se completa con reglas simples y, si hace
//     falta, con Gemini. Así «Vence el 10» continúa «Registrar gasto fijo de 100000 en impuestos» en vez de tomarse como un gasto.
//  2) Si suena a configuración, Gemini interpreta el pedido y el backend lo valida (pregunta lo que falte).
// Fuera de una transacción: la llamada a Gemini no debe retener la única conexión de la base.
const EXPENSE_VERBS=/\b(gaste|pague|compre|me costo|salio|gastamos|pagamos)\b/;
export async function adminFlow(pool:Pool,interpreter:()=>AdminInterpreter|null,p:{family:string;memberId:string;text:string;at:Date;familyCurrency:string;hasConversation:boolean}):Promise<{outcome:'admin_config';reply:string}|null>{
 const row=(await pool.query("SELECT action FROM appgastos.admin_actions WHERE family_id=$1 AND member_id=$2 AND state='pending' AND expires_at>$3",[p.family,p.memberId,p.at])).rows[0] as {action:StoredAction}|undefined;
 const collecting=row?.action.type==='collecting'?row.action:null;
 const wantsConfig=looksLikeAdminRequest(p.text);
 if(!(collecting&&!p.hasConversation)&&!(wantsConfig&&!p.hasConversation))return null;
 const categories=(await pool.query('SELECT id,name,active,parent_id FROM appgastos.categories WHERE family_id=$1',[p.family])).rows as {id:string;name:string;active:boolean;parent_id:string|null}[];
 const context=(pending?:AdminContext['pending']):AdminContext=>({text:p.text,referenceDate:referenceDate(p.at),pending,
  categories:categories.filter(c=>c.active).map(c=>({name:c.name,parent:categories.find(x=>x.id===c.parent_id)?.name??null})),fixed:[]});
 const withFixed=async(c:AdminContext)=>({...c,fixed:(await pool.query('SELECT name FROM appgastos.fixed_expenses WHERE family_id=$1',[p.family])).rows.map((r:{name:string})=>r.name)});
 if(collecting&&!p.hasConversation&&!(EXPENSE_VERBS.test(normalizeName(p.text))&&!wantsConfig)){
  let patch=answerToAsk(collecting.asking,p.text,categories);
  if(!patch){
   const interpret=interpreter();
   if(interpret){try{const i=await interpret(await withFixed(context({intent:collecting.intent,asking:collecting.asking})));if(i.action!=='none')patch=i;}catch{/* sin interpretación: se repite la pregunta */}}
  }
  if(!patch)return {outcome:'admin_config',reply:'Perdón, no te entendí. '+collecting.question};
  return prepareAdminAction(pool,p.family,{id:p.memberId},mergeIntent(collecting.intent,patch),p.at,p.familyCurrency);
 }
 const interpret=interpreter();
 if(!interpret)return null;
 try{
  const intent=await interpret(await withFixed(context()));
  return await prepareAdminAction(pool,p.family,{id:p.memberId},intent,p.at,p.familyCurrency);
 }catch{return null;} // sin interpretación: sigue como un gasto común
}
