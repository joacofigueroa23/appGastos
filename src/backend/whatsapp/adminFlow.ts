import type {Pool} from 'pg';
import {normalizeName,referenceDate} from './candidate';
import {actionToIntent,answerToAsk,correctionPatch,mergeIntent,prepareAdminAction,type StoredAction} from './admin';
import {aiRoutesAll,isStrongConfig,likelyExpense,looksLikeAdminRequest,type AdminContext,type AdminInterpreter} from './adminIntent';
// Ruta de un mensaje de TEXTO de un administrador hacia la configuración conversacional. Devuelve la respuesta o null (no era para esto).
//  1) Pedido "juntando datos" (el bot hizo una pregunta): el mensaje es la respuesta. Se completa con reglas simples y, si hace falta, con Gemini.
//     Así «Vence el 10» continúa «Registrar gasto fijo de 100000 en impuestos» en vez de tomarse como un gasto.
//  2) Pedido ya listo para confirmar: un mensaje corto que corrige un dato («no, son 120 mil», «fue ayer») lo corrige sin cambiar el tipo de pedido.
//  3) Pedido nuevo: si suena a configuración, Gemini lo interpreta y el backend lo valida (y pregunta lo que falte).
// Un pedido de configuración «fuerte» nunca cae al flujo de gastos si Gemini no responde: se le pide al usuario que reintente.
// Fuera de una transacción: la llamada a Gemini no debe retener la única conexión de la base.
const EXPENSE_VERBS=/\b(gaste|pague|compre|me costo|salio|gastamos|pagamos)\b/;
const CORRECTION_WORDS=/\b(no|mejor|cambia|cambiale|corregi|corregir|perdon|en realidad|queria decir|digo)\b/;
export const RETRY_REPLY='Ahora no pude interpretar tu pedido. Probá de nuevo en un ratito, o cargalo desde la web.';
export async function adminFlow(pool:Pool,interpreter:()=>AdminInterpreter|null,p:{family:string;memberId:string;text:string;at:Date;familyCurrency:string;hasConversation:boolean}):Promise<{outcome:'admin_config';reply:string}|null>{
 const row=(await pool.query("SELECT action FROM appgastos.admin_actions WHERE family_id=$1 AND member_id=$2 AND state='pending' AND expires_at>$3",[p.family,p.memberId,p.at])).rows[0] as {action:StoredAction}|undefined;
 const pending=row?.action;
 const collecting=pending?.type==='collecting'?pending:null;
 const ready=pending&&pending.type!=='collecting'?pending:null;
 const wantsConfig=looksLikeAdminRequest(p.text),strong=isStrongConfig(p.text);
 // Un mensaje ambiguo de un administrador (ni gasto evidente ni palabra de configuración) también se clasifica con Gemini: «El colegio sale 180 mil y se paga el 10».
 // Si no era configuración, Gemini responde none y el mensaje sigue su camino de gasto. Un fallo de Gemini acá nunca bloquea el gasto.
 const classify=!wantsConfig&&aiRoutesAll()&&!likelyExpense(p.text)&&normalizeName(p.text).split(' ').length>=3;
 const normalized=normalizeName(p.text);
 const looksExpense=EXPENSE_VERBS.test(normalized)&&!wantsConfig;
 const answering=!p.hasConversation&&!looksExpense&&!!(collecting||ready);
 // Con un gasto en curso (conversación de Fase 1), "sí/no/el 10" son de ese gasto: solo un pedido de configuración claro entra por acá.
 if(!answering&&!((wantsConfig||classify)&&(!p.hasConversation||strong)))return null;
 const categories=(await pool.query('SELECT id,name,active,parent_id FROM appgastos.categories WHERE family_id=$1',[p.family])).rows as {id:string;name:string;active:boolean;parent_id:string|null}[];
 const today=referenceDate(p.at);
 const context=(pendingIntent?:AdminContext['pending']):AdminContext=>({text:p.text,referenceDate:today,pending:pendingIntent,
  categories:categories.filter(c=>c.active).map(c=>({name:c.name,parent:categories.find(x=>x.id===c.parent_id)?.name??null})),fixed:[]});
 const withFixed=async(c:AdminContext)=>({...c,fixed:(await pool.query('SELECT name FROM appgastos.fixed_expenses WHERE family_id=$1',[p.family])).rows.map((r:{name:string})=>r.name)});
 const ask=async(c:AdminContext)=>{const interpret=interpreter();if(!interpret)return null;try{return await interpret(await withFixed(c));}catch{return null;}};
 // 1) Completar un pedido que quedó a medias.
 if(collecting&&answering){
  let patch=answerToAsk(collecting.asking,p.text,categories,today);
  if(!patch){const i=await ask(context({intent:collecting.intent,asking:collecting.asking}));if(i&&i.action!=='none')patch=i;}
  if(!patch)return {outcome:'admin_config',reply:'Perdón, no te entendí. '+collecting.question};
  return prepareAdminAction(pool,p.family,{id:p.memberId},mergeIntent(collecting.intent,patch),p.at,p.familyCurrency);
 }
 // 2) Corregir un dato de un pedido listo para confirmar (sin cambiar de pedido).
 if(ready&&answering&&!strong){
  const base=actionToIntent(ready);
  if(base){
   let patch=correctionPatch(ready,p.text,categories,today);
   if(!patch&&(CORRECTION_WORDS.test(normalized)||/\d/.test(normalized))){
    const i=await ask(context({intent:base,asking:'corrección del pedido pendiente'}));
    // Solo se acepta como corrección si Gemini devuelve el MISMO tipo de pedido (o ninguno): otro pedido es otro tema.
    if(i&&(i.action===base.action||i.action==='none'))patch=i.action==='none'?null:i;
    else if(i&&i.action!=='none'&&wantsConfig)return prepareAdminAction(pool,p.family,{id:p.memberId},i,p.at,p.familyCurrency);
   }
   if(patch)return prepareAdminAction(pool,p.family,{id:p.memberId},mergeIntent(base,patch),p.at,p.familyCurrency,{prefix:'Dale, lo corregí.'});
  }
  if(!wantsConfig)return null;
 }
 // 3) Pedido nuevo.
 if(!wantsConfig&&!(classify&&!p.hasConversation))return null;
 const intent=await ask(context());
 if(!intent)return strong?{outcome:'admin_config',reply:RETRY_REPLY}:null;
 return prepareAdminAction(pool,p.family,{id:p.memberId},intent,p.at,p.familyCurrency);
}
