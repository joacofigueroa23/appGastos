import type {Pool} from 'pg';
import type {Actor} from '../accounts/policy';
import {budgetReport} from '../budgets/service';
import {fixedService} from '../fixed/service';
import {normalizeName,referenceDate} from './candidate';
import {formatAmount} from './replies';
// Consultas financieras por WhatsApp. Se reconocen con reglas deterministas (nunca Gemini) y se responden con SQL que aplica
// los mismos permisos que la web: el rol sale del número vinculado, no de lo que diga el mensaje.
export type QueryIntent=
 |{kind:'my_total'}|{kind:'my_top_category'}|{kind:'my_last'}|{kind:'my_category';category:string}
 |{kind:'family_total'}|{kind:'budget_left';category:string}|{kind:'fixed_due_week'}|{kind:'by_member'};
export const ADMIN_ONLY:readonly QueryIntent['kind'][]=['family_total','budget_left','fixed_due_week','by_member'];
export const QUERY_DENIED='Esa consulta es solo para administradores.';
const clean=(text:string)=>normalizeName(text).replace(/[.,;:!?¡¿"']/g,' ').replace(/\s+/g,' ').trim();
// Anclado al inicio: "Gasté 35 mil en Carrefour" es un gasto, no una consulta.
export function parseQuery(text:string|null):QueryIntent|null{
 const t=clean(text??'');let m:RegExpExecArray|null;
 if(/^cuanto (gastamos|llevamos gastado|se gasto)\b/.test(t))return {kind:'family_total'};
 if((m=/^cuanto queda (?:del|de) presupuesto (?:de |del |para )?(.+?)(?: este mes)?$/.exec(t)))return {kind:'budget_left',category:m[1]};
 if(/^(que )?(gastos fijos|vencimientos|obligaciones)( que)? (vencen|vence)\b|^que vence esta semana\b|^que gastos fijos vencen\b/.test(t))return {kind:'fixed_due_week'};
 if(/^(cuanto gasto cada integrante|cuanto gasto cada uno|gasto por integrante)\b/.test(t))return {kind:'by_member'};
 if(/^en que categoria gaste mas\b/.test(t))return {kind:'my_top_category'};
 if(/^(mostrame|muestrame|mostra|dame|ver) (mis )?ultimos gastos\b|^mis ultimos gastos\b/.test(t))return {kind:'my_last'};
 if((m=/^cuanto gaste en (.+?)(?: este mes)?$/.exec(t)))return {kind:'my_category',category:m[1]};
 if(/^cuanto gaste( este mes)?$/.test(t))return {kind:'my_total'};
 return null;
}
const same=(a:string,b:string)=>normalizeName(a)===normalizeName(b);
export async function answerQuery(pool:Pool,family:string,actor:Actor,intent:QueryIntent,at:Date,familyCurrency:string):Promise<{outcome:'query'|'query_denied';reply:string}>{
 if(actor.role!=='admin'&&ADMIN_ONLY.includes(intent.kind))return {outcome:'query_denied',reply:QUERY_DENIED};
 const today=referenceDate(at),month=today.slice(0,7),first=month+'-01',money=(v:string)=>formatAmount(v.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''),familyCurrency,familyCurrency);
 const own=actor.memberId??'00000000-0000-0000-0000-000000000000';
 const base=`FROM appgastos.expenses e JOIN appgastos.categories c ON c.family_id=e.family_id AND c.id=e.category_id
  WHERE e.family_id=$1 AND e.currency=$2 AND e.date>=$3::date AND e.date<($3::date+interval '1 month')`;
 const lines=`FROM appgastos.expense_lines l JOIN appgastos.categories c ON c.family_id=l.family_id AND c.id=l.category_id
  WHERE l.family_id=$1 AND l.currency=$2 AND l.date>=$3::date AND l.date<($3::date+interval '1 month')`;
 const reply=(text:string)=>({outcome:'query' as const,reply:text});
 const categories=(await pool.query('SELECT id,name FROM appgastos.categories WHERE family_id=$1',[family])).rows as {id:string;name:string}[];
 const findCategory=(raw:string)=>{
  const exact=categories.find(c=>same(c.name,raw));if(exact)return exact;
  const part=categories.filter(c=>normalizeName(c.name).includes(normalizeName(raw)));return part.length===1?part[0]:undefined;
 };
 const mine=(await pool.query(`SELECT COALESCE(sum(e.amount),0)::text AS total,count(*)::int AS n,
   COALESCE(sum(e.amount) FILTER (WHERE e.scope='personal'),0)::text AS personal,COALESCE(sum(e.amount) FILTER (WHERE e.scope='household'),0)::text AS household ${base} AND e.reported_by_member_id=$4`,[family,familyCurrency,first,own])).rows[0];
 switch(intent.kind){
  case 'my_total':
   return reply(mine.n?`Este mes registraste ${money(mine.total)} en ${mine.n} ${mine.n===1?'gasto':'gastos'}: ${money(mine.personal)} personales y ${money(mine.household)} de la casa.`:'Este mes todavía no registraste gastos.');
  case 'my_top_category':{
   // Por categoría se leen los conceptos (expense_lines): un ticket de varias categorías reparte su importe, sin contarlo dos veces.
   const rows=(await pool.query(`SELECT c.name,sum(l.amount)::text AS total ${lines} AND l.reported_by_member_id=$4 GROUP BY c.name ORDER BY sum(l.amount) DESC,c.name LIMIT 3`,[family,familyCurrency,first,own])).rows;
   return reply(rows.length?'Tus categorías con más gasto este mes: '+rows.map((r,i)=>`${i+1}) ${r.name} ${money(r.total)}`).join(', ')+'.':'Este mes todavía no registraste gastos.');
  }
  case 'my_last':{
   const rows=(await pool.query(`SELECT to_char(e.date,'DD/MM') AS d,COALESCE(e.merchant,e.description) AS what,e.amount::text AS amount FROM appgastos.expenses e WHERE e.family_id=$1 AND e.reported_by_member_id=$2 ORDER BY e.date DESC,e.created_at DESC LIMIT 5`,[family,own])).rows;
   return reply(rows.length?'Tus últimos gastos: '+rows.map(r=>`${r.d} ${r.what} ${money(r.amount)}`).join('; ')+'.':'Todavía no registraste gastos.');
  }
  case 'my_category':{
   const c=findCategory(intent.category);if(!c)return reply('No encontré esa categoría.');
   const r=(await pool.query(`SELECT COALESCE(sum(l.amount),0)::text AS total ${lines} AND l.reported_by_member_id=$4 AND l.category_id=$5`,[family,familyCurrency,first,own,c.id])).rows[0];
   return reply(`Este mes gastaste ${money(r.total)} en ${c.name}.`);
  }
  case 'family_total':{
   const r=(await pool.query(`SELECT COALESCE(sum(e.amount),0)::text AS total,count(*)::int AS n,COALESCE(sum(e.amount) FILTER (WHERE e.scope='personal'),0)::text AS personal,
    COALESCE(sum(e.amount) FILTER (WHERE e.scope='household'),0)::text AS household,COALESCE(sum(e.amount) FILTER (WHERE e.scope IS NULL),0)::text AS unclassified ${base}`,[family,familyCurrency,first])).rows[0];
   return reply(r.n?`Este mes la familia gastó ${money(r.total)} en ${r.n} gastos: ${money(r.personal)} personales, ${money(r.household)} de la casa${Number(r.unclassified)?` y ${money(r.unclassified)} sin clasificar`:''}.`:'Este mes todavía no hay gastos registrados.');
  }
  case 'by_member':{
   const rows=(await pool.query(`SELECT COALESCE(m.name,'Sin autor identificado') AS name,sum(e.amount)::text AS total FROM appgastos.expenses e LEFT JOIN appgastos.family_members m ON m.id=e.reported_by_member_id
    WHERE e.family_id=$1 AND e.currency=$2 AND e.date>=$3::date AND e.date<($3::date+interval '1 month') GROUP BY m.name ORDER BY sum(e.amount) DESC,m.name`,[family,familyCurrency,first])).rows;
   return reply(rows.length?'Gasto por integrante este mes: '+rows.map(r=>`${r.name} ${money(r.total)}`).join('; ')+'.':'Este mes todavía no hay gastos registrados.');
  }
  case 'budget_left':{
   const c=findCategory(intent.category);if(!c)return reply('No encontré esa categoría.');
   const line=(await budgetReport(pool,family,month)).budgets.find(b=>b.categoryId===c.id);
   if(!line)return reply(`No hay presupuesto cargado para ${c.name} este mes.`);
   return reply(`${c.name}: presupuesto ${money(line.amount)}, gastado ${money(line.spent)} (${line.percent.toLocaleString('es-AR')}%). ${line.exceeded?'Te pasaste por '+money(String(-Number(line.available)))+'.':'Quedan '+money(line.available)+'.'}`);
  }
  case 'fixed_due_week':{
   const end=new Date(Date.parse(today+'T12:00:00Z')+6*86400000).toISOString().slice(0,10);
   const months=[...new Set([today.slice(0,7),end.slice(0,7)])];
   const fixed=fixedService(pool,family);
   const due=(await Promise.all(months.map(m=>fixed.occurrences(m)))).flat().filter(o=>o.status!=='paid'&&o.dueDate>=today&&o.dueDate<=end);
   const overdue=await fixed.overdue();
   if(!due.length&&!overdue.length)return reply('No hay gastos fijos que venzan esta semana.');
   return reply((due.length?'Vencen esta semana: '+due.map(o=>`${o.name} el ${o.dueDate.slice(8)}/${o.dueDate.slice(5,7)} ${money(o.expectedAmount)}`).join('; ')+'.':'No hay vencimientos esta semana.')+(overdue.length?` Vencidos sin pagar: ${overdue.map(o=>o.name).join(', ')}.`:''));
  }
 }
}
