import type {Pool} from 'pg';
import type {Actor} from '../accounts/policy';
import {expenseService} from '../expenses/service';
import {transaction} from '../expenses/repository';
import {ApiError} from '../shared/errors';
import {object,uuid} from '../shared/validators';
import {referenceDate} from '../whatsapp/candidate';
// "Marcar como pagada": el administrador informa el pago. Se crea un gasto REAL de la casa (con su autor, categoría y fecha) y se
// vincula a la obligación. Así la obligación sigue siendo "pagada = tiene un gasto" y el presupuesto y los totales lo cuentan una vez.
// Importe y fecha son opcionales: por defecto el importe previsto y hoy. El medio de pago es obligatorio (lo valida el gasto).
export async function payOccurrence(pool:Pool,family:string,actor:Actor,occurrenceId:string,body:unknown){
 const input=object(body);
 if(Object.keys(input).some(k=>!['paymentMethod','cardId','amount','date'].includes(k)))throw new ApiError(400,'Campos del pago inválidos.');
 return transaction(pool,async db=>{
  const o=(await db.query(`SELECT o.id,o.expense_id,o.expected_amount::text AS amount,o.installment_number AS n,f.name,f.category_id AS "categoryId",f.installments_total AS total,f.currency
   FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id WHERE o.family_id=$1 AND o.id=$2 FOR UPDATE OF o`,[family,uuid(occurrenceId)])).rows[0];
  if(!o)throw new ApiError(404,'Obligación inexistente.');
  if(o.expense_id)throw new ApiError(409,'La obligación ya está pagada.');
  const expense=await expenseService(pool,family,actor).createExpense({
   date:input.date??referenceDate(new Date()),amount:input.amount??o.amount,currency:o.currency,categoryId:o.categoryId,scope:'household',
   description:o.name+(o.total?` · cuota ${o.n}/${o.total}`:''),paymentMethod:input.paymentMethod,cardId:input.cardId??null,
  },'manual',db);
  // El vínculo automático del gasto pudo caer en otra obligación igual (mismo importe y categoría): esta es la que eligió el administrador.
  await db.query('UPDATE appgastos.fixed_expense_occurrences SET expense_id=NULL,link_source=NULL WHERE expense_id=$1 AND id<>$2',[expense.id,o.id]);
  await db.query("UPDATE appgastos.fixed_expense_occurrences SET expense_id=$2,link_source='manual' WHERE id=$1 AND (expense_id IS NULL OR expense_id=$2)",[o.id,expense.id]);
  return expense;
 });
}
