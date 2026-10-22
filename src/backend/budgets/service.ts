import type {Pool} from 'pg';
import {normalizeAmount} from '../expenses/validation';
import {inTransaction,type Connection} from '../expenses/repository';
import {ApiError} from '../shared/errors';
import {uuid} from '../shared/validators';
import {monthStart} from '../shared/route';
import {referenceDate} from '../whatsapp/candidate';
import type {BudgetLine,BudgetReport} from '../../shared/apiTypes';
const CURRENCY='ARS'; // primera versión: pesos, como el dashboard
const cents=(v:string)=>Math.round(Number(v)*100);
const text=(c:number)=>(c/100).toFixed(2);

// ---- Presupuesto vigente de un mes. Sin proceso mensual: se calcula por período.
//  base      = fila más reciente de budget_bases con effective_from <= mes (amount NULL = sin presupuesto desde esa fecha).
//  excepción = fila de budgets de ESE mes; tiene prioridad sobre la base y no la modifica.
export interface EffectiveBudget {categoryId:string;parentId:string|null;categoryName:string;amount:string;baseAmount:string|null;source:'base'|'exception'}
export async function effectiveBudgets(db:Connection,family:string,month:string):Promise<EffectiveBudget[]>{
 return (await db.query(`WITH base AS (SELECT DISTINCT ON (category_id) category_id,amount FROM appgastos.budget_bases
    WHERE family_id=$1 AND currency=$3 AND effective_from<=$2::date ORDER BY category_id,effective_from DESC),
   exc AS (SELECT category_id,amount FROM appgastos.budgets WHERE family_id=$1 AND month=$2::date AND currency=$3)
  SELECT c.id AS "categoryId",c.parent_id AS "parentId",c.name AS "categoryName",COALESCE(exc.amount,base.amount)::text AS amount,base.amount::text AS "baseAmount",
   CASE WHEN exc.amount IS NOT NULL THEN 'exception' ELSE 'base' END AS source
  FROM appgastos.categories c LEFT JOIN base ON base.category_id=c.id LEFT JOIN exc ON exc.category_id=c.id
  WHERE c.family_id=$1 AND COALESCE(exc.amount,base.amount) IS NOT NULL ORDER BY c.name`,[family,month,CURRENCY])).rows;
}
// Gasto VARIABLE por categoría en el mes: un gasto que paga una obligación fija (is_fixed) no consume presupuestos. Se lee de expense_lines
// (conceptos si el gasto los tiene), así un ticket de varias categorías reparte su importe sin contarse dos veces.
async function variableSpend(db:Connection,family:string,month:string){
 return (await db.query(`SELECT l.category_id AS "categoryId",c.parent_id AS "parentId",c.name AS "categoryName",sum(l.amount)::text AS spent
   FROM appgastos.expense_lines l JOIN appgastos.categories c ON c.family_id=l.family_id AND c.id=l.category_id
   WHERE l.family_id=$1 AND l.currency=$3 AND NOT l.is_fixed AND l.date>=$2::date AND l.date<($2::date+interval '1 month') GROUP BY l.category_id,c.parent_id,c.name`,[family,month,CURRENCY])).rows as {categoryId:string;parentId:string|null;categoryName:string;spent:string}[];
}

// Jerarquía sin doble contabilización: el presupuesto de una categoría principal INCLUYE a sus subcategorías (no se suman padre e hijo);
// un gasto de una subcategoría consume su límite y el del padre; si no hay presupuesto padre, no se inventa uno.
export async function budgetReport(db:Connection,family:string,monthKey:string):Promise<BudgetReport>{
 const month=monthStart(monthKey),budgets=await effectiveBudgets(db,family,month),spendRows=await variableSpend(db,family,month);
 const budgeted=new Set(budgets.map(b=>b.categoryId)),own=new Map(spendRows.map(r=>[r.categoryId,cents(r.spent)]));
 const spentBy=(b:EffectiveBudget)=>{
  let sum=own.get(b.categoryId)||0;
  if(!b.parentId)for(const r of spendRows)if(r.parentId===b.categoryId)sum+=cents(r.spent);
  return sum;
 };
 const lines:BudgetLine[]=budgets.map(b=>{
  const amount=cents(b.amount),spent=spentBy(b);
  return {categoryId:b.categoryId,categoryName:b.categoryName,amount:b.amount,spent:text(spent),available:text(amount-spent),percent:Math.round(spent/amount*1000)/10,exceeded:spent>amount,parentId:b.parentId,source:b.source,baseAmount:b.baseAmount};
 });
 // Cada gasto cuenta una vez: lo cubre el presupuesto de su categoría o, si no tiene, el de su categoría principal.
 const covered=(r:{categoryId:string;parentId:string|null})=>budgeted.has(r.categoryId)||(r.parentId!==null&&budgeted.has(r.parentId));
 const unbudgeted=spendRows.filter(r=>!covered(r)).map(r=>({categoryId:r.categoryId,categoryName:r.categoryName,spent:r.spent})).sort((a,b)=>cents(b.spent)-cents(a.spent)||a.categoryName.localeCompare(b.categoryName));
 // Total presupuestado: categorías principales con presupuesto + subcategorías cuyo padre NO tiene presupuesto. Nunca padre + hijo.
 const counted=budgets.filter(b=>!b.parentId||!budgeted.has(b.parentId));
 const total=counted.reduce((n,b)=>n+cents(b.amount),0),spent=counted.reduce((n,b)=>n+spentBy(b),0);
 const all=spendRows.reduce((n,r)=>n+cents(r.spent),0),uncovered=spendRows.filter(r=>!covered(r)).reduce((n,r)=>n+cents(r.spent),0);
 return {month:monthKey,currency:CURRENCY,budgets:lines,unbudgeted,totals:{
  budgeted:text(total),spent:text(spent),available:text(total-spent),percent:total?Math.round(spent/total*1000)/10:0,
  unbudgetedSpent:text(uncovered),totalSpent:text(all),exceededCount:lines.filter(l=>l.exceeded).length}};
}

export function budgetService(pool:Pool,family:string,byMemberId:string|null){
 const category=async(db:Connection,id:unknown)=>{
  const c=(await db.query('SELECT id,parent_id AS "parentId",name FROM appgastos.categories WHERE family_id=$1 AND id=$2',[family,uuid(id,'categoryId')])).rows[0];
  if(!c)throw new ApiError(404,'Categoría inexistente.');
  return c as {id:string;parentId:string|null;name:string};
 };
 // La suma de los límites de las subcategorías no puede superar un límite explícito de la categoría principal (en el mes que se modifica).
 // shortcut: se valida solo el mes de vigencia; una base futura distinta no se revisa, el administrador la ve al llegar ese mes.
 async function checkLimits(db:Connection,month:string,cat:{id:string;parentId:string|null},amount:number|null){
  const eff=await effectiveBudgets(db,family,month),amounts=new Map(eff.map(b=>[b.categoryId,cents(b.amount)]));
  if(amount===null)amounts.delete(cat.id);else amounts.set(cat.id,amount);
  const parentId=cat.parentId??cat.id,limit=amounts.get(parentId);
  if(limit===undefined)return;
  const sum=[...amounts.entries()].filter(([id])=>eff.some(b=>b.categoryId===id&&b.parentId===parentId)||(id===cat.id&&cat.parentId===parentId)).reduce((n,[,v])=>n+v,0);
  if(sum>limit)throw new ApiError(409,'La suma de las subcategorías ('+text(sum)+') supera el presupuesto de la categoría principal ('+text(limit)+').');
 }
 return {
  report:(month:string)=>budgetReport(pool,family,month),
  effective:(monthKey:string)=>effectiveBudgets(pool,family,monthStart(monthKey)),
  // Presupuesto BASE recurrente: rige desde `from` (por defecto el mes actual) y se renueva solo cada mes. No cambia meses anteriores.
  async setBase(categoryId:unknown,amount:unknown,from?:unknown){
   const value=normalizeAmount(amount),start=from===undefined?referenceDate(new Date()).slice(0,7)+'-01':monthStart(from,'from');
   return inTransaction(pool,async db=>{
    const cat=await category(db,categoryId);
    await checkLimits(db,start,cat,cents(value));
    await db.query(`INSERT INTO appgastos.budget_bases(family_id,category_id,currency,effective_from,amount,updated_by_member_id) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(family_id,category_id,currency,effective_from) DO UPDATE SET amount=EXCLUDED.amount,updated_by_member_id=EXCLUDED.updated_by_member_id`,[family,cat.id,CURRENCY,start,value,byMemberId]);
   });
  },
  // Finaliza la base desde un mes (sin borrar el historial): desde ahí no hay presupuesto base para la categoría.
  async endBase(categoryId:unknown,from?:unknown){
   const start=from===undefined?referenceDate(new Date()).slice(0,7)+'-01':monthStart(from,'from');
   return inTransaction(pool,async db=>{
    const cat=await category(db,categoryId);
    if(!(await db.query('SELECT 1 FROM appgastos.budget_bases WHERE family_id=$1 AND category_id=$2 AND currency=$3 AND amount IS NOT NULL AND effective_from<=$4::date LIMIT 1',[family,cat.id,CURRENCY,start])).rowCount)throw new ApiError(404,'No hay presupuesto base vigente para esa categoría.');
    await db.query(`INSERT INTO appgastos.budget_bases(family_id,category_id,currency,effective_from,amount,updated_by_member_id) VALUES($1,$2,$3,$4,NULL,$5)
     ON CONFLICT(family_id,category_id,currency,effective_from) DO UPDATE SET amount=NULL,updated_by_member_id=EXCLUDED.updated_by_member_id`,[family,cat.id,CURRENCY,start,byMemberId]);
   });
  },
  // Excepción de UN mes: reemplaza la base solo en ese mes. Quitarla vuelve a la base.
  async set(monthKey:string,categoryId:unknown,amount:unknown){
   const month=monthStart(monthKey),value=normalizeAmount(amount);
   return inTransaction(pool,async db=>{
    const cat=await category(db,categoryId);
    await checkLimits(db,month,cat,cents(value));
    await db.query(`INSERT INTO appgastos.budgets(family_id,category_id,month,currency,amount,updated_by_member_id) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(family_id,category_id,month,currency) DO UPDATE SET amount=EXCLUDED.amount,updated_at=now(),updated_by_member_id=EXCLUDED.updated_by_member_id`,[family,cat.id,month,CURRENCY,value,byMemberId]);
   });
  },
  async remove(monthKey:string,categoryId:unknown){
   const r=await pool.query('DELETE FROM appgastos.budgets WHERE family_id=$1 AND category_id=$2 AND month=$3::date AND currency=$4',[family,uuid(categoryId,'categoryId'),monthStart(monthKey),CURRENCY]);
   if(!r.rowCount)throw new ApiError(404,'No hay una excepción de presupuesto para esa categoría y mes.');
  },
  // Copia los presupuestos de un mes a otro como excepciones. No pisa los que ya existen en el destino ni toca otros meses.
  async copy(fromKey:unknown,toKey:unknown){
   const from=monthStart(fromKey,'from'),to=monthStart(toKey,'to');
   if(from===to)throw new ApiError(400,'El mes de origen y el de destino deben ser distintos.');
   return inTransaction(pool,async db=>(await db.query(`INSERT INTO appgastos.budgets(family_id,category_id,month,currency,amount,updated_by_member_id)
     SELECT family_id,category_id,$3::date,currency,amount,$4 FROM appgastos.budgets WHERE family_id=$1 AND month=$2::date AND currency=$5
     ON CONFLICT(family_id,category_id,month,currency) DO NOTHING`,[family,from,to,byMemberId,CURRENCY])).rowCount??0);
  },
 };
}
