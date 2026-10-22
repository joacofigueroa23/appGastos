import {budgetReport} from '../budgets/service';
import {generateOccurrences} from '../fixed/service';
import {inTransaction,type Connection} from '../expenses/repository';
import {monthStart} from '../shared/route';
import type {Pool} from 'pg';
import type {ControlSummary} from '../../shared/apiTypes';
const CURRENCY='ARS'; // primera versión: pesos
const cents=(v:string)=>Math.round(Number(v)*100);
const text=(c:number)=>(c/100).toFixed(2);
const part=(row:{amount:string;count:number})=>({amount:text(cents(row.amount)),count:row.count});
// Dos controles independientes, mostrados por separado:
//  * Gastos fijos: obligaciones del mes. PAGADOS = gastos vinculados a una obligación con fecha efectiva en el mes (un pago atrasado se cuenta
//    en el mes en que se pagó y su obligación sigue asociada a su mes de origen). PENDIENTES = obligaciones del mes sin pagar (no son gasto).
//    DEUDAS ANTERIORES = obligaciones sin pagar de meses previos.
//  * Presupuestos variables: lo presupuestado, lo consumido y lo disponible; los pagos de obligaciones NO consumen presupuesto.
// Total gastado = fijos pagados + variables registrados. Cada movimiento cuenta una sola vez.
export async function controlSummary(pool:Pool|Connection,family:string,monthKey:string,today:string):Promise<ControlSummary>{
 const month=monthStart(monthKey);
 return inTransaction(pool,async db=>{
  // Idempotente: crea las obligaciones que falten (este mes y los anteriores) sin duplicar.
  await generateOccurrences(db,family,'0001-01',monthKey);
  const one=async(sql:string,args:unknown[])=>(await db.query(sql,args)).rows[0] as {amount:string;count:number};
  const paid=await one(`SELECT COALESCE(sum(e.amount),0)::text AS amount,count(*)::int AS count FROM appgastos.expenses e JOIN appgastos.fixed_expense_occurrences o ON o.expense_id=e.id
    WHERE e.family_id=$1 AND e.currency=$3 AND e.date>=$2::date AND e.date<($2::date+interval '1 month')`,[family,month,CURRENCY]);
  const paidLate=await one(`SELECT COALESCE(sum(e.amount),0)::text AS amount,count(*)::int AS count FROM appgastos.expenses e JOIN appgastos.fixed_expense_occurrences o ON o.expense_id=e.id
    WHERE e.family_id=$1 AND e.currency=$3 AND e.date>=$2::date AND e.date<($2::date+interval '1 month') AND o.period<$2::date`,[family,month,CURRENCY]);
  const pending=await one(`SELECT COALESCE(sum(o.expected_amount),0)::text AS amount,count(*)::int AS count FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
    WHERE o.family_id=$1 AND f.currency=$3 AND o.period=$2::date AND o.expense_id IS NULL`,[family,month,CURRENCY]);
  const overdue=await one(`SELECT COALESCE(sum(o.expected_amount),0)::text AS amount,count(*)::int AS count FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
    WHERE o.family_id=$1 AND f.currency=$3 AND o.period=$2::date AND o.expense_id IS NULL AND o.due_date<$4::date`,[family,month,CURRENCY,today]);
  const previous=await one(`SELECT COALESCE(sum(o.expected_amount),0)::text AS amount,count(*)::int AS count FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
    WHERE o.family_id=$1 AND f.currency=$3 AND o.period<$2::date AND o.expense_id IS NULL`,[family,month,CURRENCY]);
  const budget=await budgetReport(db,family,monthKey);
  return {month:monthKey,currency:CURRENCY,
   fixed:{paid:part(paid),paidLate:part(paidLate),pending:part(pending),overdue:part(overdue),previousDebts:part(previous)},
   variable:{budgeted:budget.totals.budgeted,spent:budget.totals.spent,available:budget.totals.available,percent:budget.totals.percent,unbudgetedSpent:budget.totals.unbudgetedSpent,registered:budget.totals.totalSpent},
   totalSpent:text(cents(paid.amount)+cents(budget.totals.totalSpent))};
 });
}
