import type {Pool} from 'pg';
import {normalizeAmount} from '../expenses/validation';
import {transaction,type Connection} from '../expenses/repository';
import {ApiError} from '../shared/errors';
import {uuid} from '../shared/validators';
import {monthStart} from '../shared/route';
import type {BudgetLine,BudgetReport} from '../../shared/apiTypes';
const CURRENCY='ARS'; // primera versión: pesos, como el dashboard
const SPENT=`(SELECT category_id,sum(amount) AS spent FROM appgastos.expenses
  WHERE family_id=$1 AND currency=$3 AND date>=$2::date AND date<($2::date+interval '1 month') GROUP BY category_id)`;
// Un solo lugar calcula el consumo: la fecha efectiva del gasto, su categoría y su importe actuales. Editar, mover de categoría,
// cambiar la fecha o borrar un gasto se refleja solo, porque no se guarda ningún acumulado.
export async function budgetReport(db:Connection,family:string,monthKey:string):Promise<BudgetReport>{
 const month=monthStart(monthKey),args=[family,month,CURRENCY];
 const lines=(await db.query(`SELECT b.category_id AS "categoryId",c.name AS "categoryName",b.amount::text AS amount,COALESCE(s.spent,0)::text AS spent,
   (b.amount-COALESCE(s.spent,0))::text AS available,round(COALESCE(s.spent,0)/b.amount*100,1)::float AS percent,COALESCE(s.spent,0)>b.amount AS exceeded
   FROM appgastos.budgets b JOIN appgastos.categories c ON c.family_id=b.family_id AND c.id=b.category_id
   LEFT JOIN ${SPENT} s ON s.category_id=b.category_id
   WHERE b.family_id=$1 AND b.month=$2::date AND b.currency=$3 ORDER BY c.name`,args)).rows as BudgetLine[];
 const unbudgeted=(await db.query(`SELECT s.category_id AS "categoryId",c.name AS "categoryName",s.spent::text AS spent
   FROM ${SPENT} s JOIN appgastos.categories c ON c.family_id=$1 AND c.id=s.category_id
   WHERE NOT EXISTS(SELECT 1 FROM appgastos.budgets b WHERE b.family_id=$1 AND b.month=$2::date AND b.currency=$3 AND b.category_id=s.category_id)
   ORDER BY s.spent DESC,c.name`,args)).rows;
 const t=(await db.query(`SELECT COALESCE((SELECT sum(amount) FROM appgastos.budgets WHERE family_id=$1 AND month=$2::date AND currency=$3),0)::numeric AS budgeted,
   COALESCE((SELECT sum(s.spent) FROM ${SPENT} s WHERE EXISTS(SELECT 1 FROM appgastos.budgets b WHERE b.family_id=$1 AND b.month=$2::date AND b.currency=$3 AND b.category_id=s.category_id)),0)::numeric AS spent,
   COALESCE((SELECT sum(s.spent) FROM ${SPENT} s),0)::numeric AS total`,args)).rows[0];
 const budgeted=Number(t.budgeted),spent=Number(t.spent);
 return {month:monthKey,currency:CURRENCY,budgets:lines,unbudgeted,totals:{
  budgeted:t.budgeted,spent:t.spent,available:(await db.query('SELECT ($1::numeric-$2::numeric)::text AS v',[t.budgeted,t.spent])).rows[0].v,
  percent:budgeted?Math.round(spent/budgeted*1000)/10:0,
  unbudgetedSpent:(await db.query('SELECT ($1::numeric-$2::numeric)::text AS v',[t.total,t.spent])).rows[0].v,totalSpent:t.total,
  exceededCount:lines.filter(l=>l.exceeded).length}};
}
export function budgetService(pool:Pool,family:string,byMemberId:string|null){
 return {
  report:(month:string)=>budgetReport(pool,family,month),
  async set(monthKey:string,categoryId:unknown,amount:unknown){
   const month=monthStart(monthKey),category=uuid(categoryId,'categoryId');
   if(!(await pool.query('SELECT 1 FROM appgastos.categories WHERE family_id=$1 AND id=$2',[family,category])).rowCount)throw new ApiError(404,'Categoría inexistente.');
   await pool.query(`INSERT INTO appgastos.budgets(family_id,category_id,month,currency,amount,updated_by_member_id) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(family_id,category_id,month,currency) DO UPDATE SET amount=EXCLUDED.amount,updated_at=now(),updated_by_member_id=EXCLUDED.updated_by_member_id`,
    [family,category,month,CURRENCY,normalizeAmount(amount),byMemberId]);
  },
  async remove(monthKey:string,categoryId:unknown){
   const r=await pool.query('DELETE FROM appgastos.budgets WHERE family_id=$1 AND category_id=$2 AND month=$3::date AND currency=$4',[family,uuid(categoryId,'categoryId'),monthStart(monthKey),CURRENCY]);
   if(!r.rowCount)throw new ApiError(404,'No hay presupuesto para esa categoría y mes.');
  },
  // Copia los presupuestos de un mes a otro. No pisa los que ya existen en el destino ni toca otros meses.
  async copy(fromKey:unknown,toKey:unknown){
   const from=monthStart(fromKey,'from'),to=monthStart(toKey,'to');
   if(from===to)throw new ApiError(400,'El mes de origen y el de destino deben ser distintos.');
   return transaction(pool,async db=>(await db.query(`INSERT INTO appgastos.budgets(family_id,category_id,month,currency,amount,updated_by_member_id)
     SELECT family_id,category_id,$3::date,currency,amount,$4 FROM appgastos.budgets WHERE family_id=$1 AND month=$2::date AND currency=$5
     ON CONFLICT(family_id,category_id,month,currency) DO NOTHING`,[family,from,to,byMemberId,CURRENCY])).rowCount??0);
  },
 };
}
