import type {Pool} from 'pg';
import {normalizeAmount} from '../expenses/validation';
import {inTransaction,type Connection} from '../expenses/repository';
import {ApiError} from '../shared/errors';
import {object,text,uuid} from '../shared/validators';
import {monthStart} from '../shared/route';
import {isDateOnly} from '../../utils/finance';
import {referenceDate} from '../whatsapp/candidate';
import type {FixedExpense,FixedOccurrence} from '../../shared/apiTypes';
const CURRENCY='ARS'; // primera versión
// Último día del mes de `period` (primer día del mes): un vencimiento 31 en febrero cae el 28 o 29.
const DUE=(day:string)=>`(o.period + (LEAST(${day},EXTRACT(day FROM (o.period + interval '1 month' - interval '1 day'))::int) - 1))::date`;
const TEMPLATE=`f.id,f.name,f.category_id AS "categoryId",c.name AS "categoryName",f.expected_amount::text AS "expectedAmount",f.currency,f.frequency,
 to_char(f.start_date,'YYYY-MM-DD') AS "startDate",f.due_day AS "dueDay",to_char(f.end_date,'YYYY-MM-DD') AS "endDate",f.installments_total AS "installmentsTotal",f.active`;
const FROM_TEMPLATE='FROM appgastos.fixed_expenses f JOIN appgastos.categories c ON c.family_id=f.family_id AND c.id=f.category_id';

function validate(body:unknown,creating:boolean){
 const input=object(body),allowed=['name','categoryId','expectedAmount','effectiveFrom','dueDay','startDate','endDate','installmentsTotal','active'];
 if(!Object.keys(input).length||Object.keys(input).some(k=>!allowed.includes(k)))throw new ApiError(400,'Campos del gasto fijo inválidos.');
 const out:Record<string,unknown>={},has=(k:string)=>Object.hasOwn(input,k);
 if(creating||has('name'))out.name=text(input.name,'name',120);
 if(creating||has('categoryId'))out.categoryId=uuid(input.categoryId,'categoryId');
 if(creating||has('expectedAmount'))out.expectedAmount=normalizeAmount(input.expectedAmount);
 // Vigencia del nuevo importe (YYYY-MM): sin ella rige desde el mes actual. Solo acompaña a expectedAmount.
 if(has('effectiveFrom')){
  if(!has('expectedAmount')||creating)throw new ApiError(400,'effectiveFrom solo se usa junto con expectedAmount al modificar.');
  out.effectiveFrom=monthStart(input.effectiveFrom,'effectiveFrom');
 }
 if(creating||has('dueDay')){
  if(!Number.isInteger(input.dueDay)||(input.dueDay as number)<1||(input.dueDay as number)>31)throw new ApiError(400,'El día de vencimiento debe estar entre 1 y 31.');
  out.dueDay=input.dueDay;
 }
 if(creating||has('startDate')){
  if(typeof input.startDate!=='string'||!isDateOnly(input.startDate))throw new ApiError(400,'startDate debe ser YYYY-MM-DD.');
  out.startDate=input.startDate;
 }
 if(has('endDate')){
  if(input.endDate!==null&&(typeof input.endDate!=='string'||!isDateOnly(input.endDate)))throw new ApiError(400,'endDate debe ser YYYY-MM-DD o null.');
  out.endDate=input.endDate;
 }
 if(has('installmentsTotal')){
  if(input.installmentsTotal!==null&&(!Number.isInteger(input.installmentsTotal)||(input.installmentsTotal as number)<1||(input.installmentsTotal as number)>600))throw new ApiError(400,'La cantidad de cuotas debe ser un entero positivo o null.');
  out.installmentsTotal=input.installmentsTotal;
 }
 if(has('active')){if(typeof input.active!=='boolean')throw new ApiError(400,'active debe ser booleano.');out.active=input.active;}
 return out;
}
const categoryExists=async(db:Connection,family:string,id:unknown)=>{
 if(!(await db.query('SELECT 1 FROM appgastos.categories WHERE family_id=$1 AND id=$2',[family,id])).rowCount)throw new ApiError(404,'Categoría inexistente.');
};

// Crea las ocurrencias que falten entre dos meses (por defecto, uno solo). Idempotente (UNIQUE + ON CONFLICT DO NOTHING) y segura
// ante pedidos simultáneos. Respeta inicio, fin, cantidad de cuotas y la duración real del mes; no toca las ya creadas (ni las pagadas).
// shortcut: hacia atrás genera como máximo 120 meses desde el mes pedido; una obligación más vieja no mostraría sus meses anteriores.
const NUMBER=(a:string)=>`((EXTRACT(year FROM ${a}.period)-EXTRACT(year FROM f.start_date))*12+EXTRACT(month FROM ${a}.period)-EXTRACT(month FROM f.start_date))::int+1`;
export async function generateOccurrences(db:Connection,family:string,fromKey:string,toKey=fromKey){
 await db.query(`INSERT INTO appgastos.fixed_expense_occurrences(family_id,fixed_expense_id,period,due_date,expected_amount,installment_number)
  SELECT f.family_id,f.id,p.period,(p.period + (LEAST(f.due_day,EXTRACT(day FROM (p.period + interval '1 month' - interval '1 day'))::int) - 1))::date,
  COALESCE((SELECT h.amount FROM appgastos.fixed_expense_amounts h WHERE h.fixed_expense_id=f.id AND h.effective_from<=p.period ORDER BY h.effective_from DESC LIMIT 1),f.expected_amount),${NUMBER('p')}
  FROM appgastos.fixed_expenses f
  CROSS JOIN LATERAL (SELECT g::date AS period FROM generate_series(
    GREATEST(f.start_date - (EXTRACT(day FROM f.start_date)::int - 1),$2::date,($3::date - interval '120 months')::date),$3::date,interval '1 month') g) p
  WHERE f.family_id=$1 AND f.active AND f.currency=$4 AND (f.end_date IS NULL OR f.end_date >= p.period)
   AND (f.installments_total IS NULL OR ${NUMBER('p')} <= f.installments_total)
  ON CONFLICT(fixed_expense_id,period) DO NOTHING`,[family,monthStart(fromKey),monthStart(toKey),CURRENCY]);
}

export interface PaidExpense {id:string;scope?:string|null;categoryId:string;date:string;amount:string;currency:string}
// Vincula (o desvincula) un gasto con la obligación que paga. Se llama dentro de la transacción que guarda el gasto, sea de la
// web o del bot. Criterio determinista: gasto de la casa, mismo mes y categoría, importe igual y UNA sola candidata sin pagar.
// Si hay 0 o varias candidatas no se asocia nada: queda como "pago sin vincular" para que lo resuelva un administrador.
// Los vínculos manuales (decididos por un administrador) no se revalidan.
export async function syncPaymentLink(db:Connection,family:string,e:PaidExpense){
 const current=(await db.query(`SELECT o.id,o.link_source FROM appgastos.fixed_expense_occurrences o WHERE o.family_id=$1 AND o.expense_id=$2 FOR UPDATE`,[family,e.id])).rows[0];
 if(current?.link_source==='manual')return;
 const period=e.date.slice(0,7)+'-01';
 if(current){
  const still=(await db.query(`SELECT 1 FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
   WHERE o.id=$1 AND $2='household' AND f.category_id=$3 AND o.period=$4::date AND f.currency=$5 AND o.expected_amount=$6::numeric`,[current.id,e.scope,e.categoryId,period,e.currency,e.amount])).rowCount;
  if(still)return;
  await db.query('UPDATE appgastos.fixed_expense_occurrences SET expense_id=NULL,link_source=NULL WHERE id=$1',[current.id]);
 }
 if(e.scope!=='household'||e.currency!==CURRENCY)return;
 await generateOccurrences(db,family,e.date.slice(0,7));
 const candidates=(await db.query(`SELECT o.id FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
  WHERE o.family_id=$1 AND o.period=$2::date AND f.category_id=$3 AND f.currency=$4 AND o.expected_amount=$5::numeric AND o.expense_id IS NULL ORDER BY o.id FOR UPDATE OF o`,[family,period,e.categoryId,e.currency,e.amount])).rows;
 if(candidates.length===1)await db.query(`UPDATE appgastos.fixed_expense_occurrences SET expense_id=$2,link_source='auto' WHERE id=$1 AND expense_id IS NULL`,[candidates[0].id,e.id]);
}

// $1 = familia, $2 = hoy (en la zona horaria de la app), $3... = parámetros propios del filtro.
// Pagada = tiene gasto vinculado; vencida = sin pagar y con fecha pasada. Ninguno de los dos estados se guarda.
const listOccurrences=async(db:Connection,family:string,where:string,extra:unknown[]=[]):Promise<FixedOccurrence[]>=>(await db.query(`SELECT o.id,o.fixed_expense_id AS "fixedExpenseId",f.name,c.name AS "categoryName",to_char(o.period,'YYYY-MM') AS month,to_char(o.due_date,'YYYY-MM-DD') AS "dueDate",
  o.expected_amount::text AS "expectedAmount",o.installment_number AS "installmentNumber",f.installments_total AS "installmentsTotal",
  o.expense_id AS "expenseId",CASE WHEN o.expense_id IS NOT NULL THEN o.link_source END AS "linkSource",e.amount::text AS "paidAmount",to_char(e.date,'YYYY-MM-DD') AS "paidDate",
  CASE WHEN o.expense_id IS NOT NULL THEN 'paid' WHEN o.due_date < $2::date THEN 'overdue' ELSE 'pending' END AS status
  FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
  JOIN appgastos.categories c ON c.family_id=f.family_id AND c.id=f.category_id LEFT JOIN appgastos.expenses e ON e.id=o.expense_id
  WHERE o.family_id=$1 AND ${where} ORDER BY o.due_date,f.name`,[family,referenceDate(new Date()),...extra])).rows;

export function fixedService(pool:Pool,family:string){
 return {
  list:async():Promise<FixedExpense[]>=>(await pool.query(`SELECT ${TEMPLATE} ${FROM_TEMPLATE} WHERE f.family_id=$1 ORDER BY f.active DESC,f.name,f.id`,[family])).rows,
  async create(body:unknown){
   const v=validate(body,true);await categoryExists(pool,family,v.categoryId);
   return inTransaction(pool,async db=>{
    const r=await db.query(`INSERT INTO appgastos.fixed_expenses(family_id,name,category_id,expected_amount,currency,start_date,due_day,end_date,installments_total,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[family,v.name,v.categoryId,v.expectedAmount,CURRENCY,v.startDate,v.dueDay,v.endDate??null,v.installmentsTotal??null,v.active??true]);
    // Historial de importes: el inicial rige desde el mes de inicio.
    await db.query('INSERT INTO appgastos.fixed_expense_amounts(fixed_expense_id,family_id,effective_from,amount) VALUES($1,$2,$3::date-(EXTRACT(day FROM $3::date)::int-1),$4)',[r.rows[0].id,family,v.startDate,v.expectedAmount]);
    return (await db.query(`SELECT ${TEMPLATE} ${FROM_TEMPLATE} WHERE f.id=$1`,[r.rows[0].id])).rows[0] as FixedExpense;
   });
  },
  // Cambiar el importe o el día afecta solo a ocurrencias SIN pagar de este mes en adelante. Lo pagado y lo anterior no se reescribe.
  async update(id:string,body:unknown){
   const v=validate(body,false);if(v.categoryId)await categoryExists(pool,family,v.categoryId);
   return inTransaction(pool,async db=>{
    const prev=(await db.query('SELECT start_date,end_date FROM appgastos.fixed_expenses WHERE family_id=$1 AND id=$2 FOR UPDATE',[family,uuid(id)])).rows[0];
    if(!prev)throw new ApiError(404,'Gasto fijo inexistente.');
    const map:Record<string,string>={name:'name',categoryId:'category_id',dueDay:'due_day',startDate:'start_date',endDate:'end_date',installmentsTotal:'installments_total',active:'active'};
    const args:unknown[]=[family,id],sets=['updated_at=now()'];
    for(const [k,col] of Object.entries(map))if(Object.hasOwn(v,k)){args.push(v[k]);sets.push(col+'=$'+args.length);}
    await db.query(`UPDATE appgastos.fixed_expenses SET ${sets.join(',')} WHERE family_id=$1 AND id=$2`,args);
    const current=referenceDate(new Date()).slice(0,7)+'-01';
    // Nuevo importe: queda en el historial con su vigencia y alcanza solo a las obligaciones SIN pagar desde ese mes. Lo pagado y lo anterior no se reescribe.
    if(v.expectedAmount){
     const from=(v.effectiveFrom as string|undefined)??current;
     await db.query('INSERT INTO appgastos.fixed_expense_amounts(fixed_expense_id,family_id,effective_from,amount) VALUES($1,$2,$3::date,$4) ON CONFLICT(fixed_expense_id,effective_from) DO UPDATE SET amount=EXCLUDED.amount',[id,family,from,v.expectedAmount]);
     await db.query('UPDATE appgastos.fixed_expenses SET expected_amount=COALESCE((SELECT amount FROM appgastos.fixed_expense_amounts WHERE fixed_expense_id=$1 AND effective_from<=$2::date ORDER BY effective_from DESC LIMIT 1),expected_amount) WHERE id=$1',[id,current]);
     await db.query(`UPDATE appgastos.fixed_expense_occurrences o SET expected_amount=(SELECT h.amount FROM appgastos.fixed_expense_amounts h WHERE h.fixed_expense_id=o.fixed_expense_id AND h.effective_from<=o.period ORDER BY h.effective_from DESC LIMIT 1)
      WHERE o.family_id=$1 AND o.fixed_expense_id=$2 AND o.expense_id IS NULL AND o.period>=$3::date`,[family,id,from]);
    }
    // Si cambian inicio, fin, cuotas o el estado, las ocurrencias SIN pagar que ya no corresponden se quitan (una fecha mal cargada no deja
    // "vencidas" fantasma) y las restantes se renumeran. Las pagadas no se tocan nunca.
    await db.query(`DELETE FROM appgastos.fixed_expense_occurrences o USING appgastos.fixed_expenses f WHERE f.id=o.fixed_expense_id AND f.id=$1 AND o.expense_id IS NULL AND (
      o.period < (f.start_date - (EXTRACT(day FROM f.start_date)::int - 1)) OR (f.end_date IS NOT NULL AND o.period > f.end_date)
      OR (f.installments_total IS NOT NULL AND ${NUMBER('o')} > f.installments_total) OR (NOT f.active AND o.period >= $2::date))`,[id,current]);
    await db.query(`UPDATE appgastos.fixed_expense_occurrences o SET installment_number=${NUMBER('o')} FROM appgastos.fixed_expenses f WHERE f.id=o.fixed_expense_id AND f.id=$1 AND o.expense_id IS NULL`,[id]);
    if(v.dueDay)await db.query(`UPDATE appgastos.fixed_expense_occurrences o SET due_date=${DUE('$3')} WHERE o.family_id=$1 AND o.fixed_expense_id=$2 AND o.expense_id IS NULL AND o.period>=$4::date`,[family,id,v.dueDay,current]);
    return (await db.query(`SELECT ${TEMPLATE} ${FROM_TEMPLATE} WHERE f.id=$1`,[id])).rows[0] as FixedExpense;
   });
  },
  async occurrences(monthKey:string):Promise<FixedOccurrence[]>{
   const period=monthStart(monthKey);
   return inTransaction(pool,async db=>{await generateOccurrences(db,family,monthKey);return listOccurrences(db,family,'o.period=$3::date',[period]);});
  },
  // Todo lo que venció y sigue sin pagar, de cualquier mes: queda a la vista hasta que se pague.
  async overdue():Promise<FixedOccurrence[]>{
   return inTransaction(pool,async db=>{await generateOccurrences(db,family,'0001-01',referenceDate(new Date()).slice(0,7));return listOccurrences(db,family,'o.expense_id IS NULL AND o.due_date < $2::date');});
  },
  // Gastos de la casa del mes que no pagan ninguna obligación: el administrador decide si corresponde vincularlos.
  async unlinked(monthKey:string){
   return (await pool.query(`SELECT e.id,to_char(e.date,'YYYY-MM-DD') AS date,e.amount::text AS amount,e.currency,e.description,c.name AS "categoryName",m.name AS "authorName"
    FROM appgastos.expenses e JOIN appgastos.categories c ON c.family_id=e.family_id AND c.id=e.category_id LEFT JOIN appgastos.family_members m ON m.id=e.reported_by_member_id
    WHERE e.family_id=$1 AND e.scope='household' AND e.date>=$2::date AND e.date<($2::date+interval '1 month')
     AND NOT EXISTS(SELECT 1 FROM appgastos.fixed_expense_occurrences o WHERE o.expense_id=e.id) ORDER BY e.date DESC,e.created_at DESC`,[family,monthStart(monthKey)])).rows;
  },
  async link(occurrenceId:string,expenseId:unknown){
   const expense=uuid(expenseId,'expenseId');
   return inTransaction(pool,async db=>{
    const o=(await db.query('SELECT id,expense_id FROM appgastos.fixed_expense_occurrences WHERE family_id=$1 AND id=$2 FOR UPDATE',[family,uuid(occurrenceId)])).rows[0];
    if(!o)throw new ApiError(404,'Obligación inexistente.');
    if(o.expense_id)throw new ApiError(409,'La obligación ya está pagada.');
    if(!(await db.query('SELECT 1 FROM appgastos.expenses WHERE family_id=$1 AND id=$2',[family,expense])).rowCount)throw new ApiError(404,'Gasto inexistente.');
    if((await db.query('SELECT 1 FROM appgastos.fixed_expense_occurrences WHERE expense_id=$1',[expense])).rowCount)throw new ApiError(409,'El gasto ya está vinculado a otra obligación.');
    await db.query("UPDATE appgastos.fixed_expense_occurrences SET expense_id=$2,link_source='manual' WHERE id=$1",[o.id,expense]);
   });
  },
  async unlink(occurrenceId:string){
   const r=await pool.query('UPDATE appgastos.fixed_expense_occurrences SET expense_id=NULL,link_source=NULL WHERE family_id=$1 AND id=$2 AND expense_id IS NOT NULL',[family,uuid(occurrenceId)]);
   if(!r.rowCount)throw new ApiError(404,'La obligación no tiene un pago vinculado.');
  },
 };
}
