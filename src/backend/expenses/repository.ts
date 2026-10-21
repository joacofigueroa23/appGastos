import type { Pool, PoolClient } from 'pg';
import type { ApiExpense, ExpenseWrite, ExpenseFilters } from '../../shared/apiTypes';
export type Connection = Pick<PoolClient, 'query'>;
const columns = [
  'e.id', 'e.family_id AS "familyId"', 'to_char(e.date, \'YYYY-MM-DD\') AS date',
  'e.amount::text AS amount', 'e.currency', 'e.merchant', 'e.description',
  'e.category_id AS "categoryId"', 'c.name AS "categoryName"', 'e.payment_method AS "paymentMethod"',
  'e.card_id AS "cardId"', 'e.reported_by_member_id AS "reportedByMemberId"', 'e.scope', 'e.source', 'e.document_id AS "documentId"', 'e.installments', 'e.refunded_amount::text AS "refundedAmount"',
  'e.created_at AS "createdAt"', 'e.updated_at AS "updatedAt"',
].join(', ');
export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
function dto(row: any): ApiExpense {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
// Conceptos por categoría de los gastos que los tienen (ticket con varias categorías). Un gasto sin conceptos no trae la clave.
async function withItems(db: Connection, familyId: string, expenses: ApiExpense[]): Promise<ApiExpense[]> {
  if (!expenses.length) return expenses;
  const rows = (await db.query('SELECT i.expense_id AS "expenseId",i.description,i.category_id AS "categoryId",c.name AS "categoryName",i.amount::text AS amount FROM appgastos.expense_items i JOIN appgastos.categories c ON c.family_id=i.family_id AND c.id=i.category_id WHERE i.family_id=$1 AND i.expense_id=ANY($2::uuid[]) ORDER BY i.expense_id,i.position', [familyId, expenses.map(e => e.id)])).rows;
  if (!rows.length) return expenses;
  const byExpense = new Map<string, any[]>();
  for (const { expenseId, ...item } of rows) byExpense.set(expenseId, [...(byExpense.get(expenseId) || []), item]);
  return expenses.map(e => byExpense.has(e.id) ? { ...e, items: byExpense.get(e.id)! } : e);
}
export async function findExpense(db: Connection, familyId: string, id: string): Promise<ApiExpense | null> {
  const result = await db.query('SELECT ' + columns + ' FROM appgastos.expenses e JOIN appgastos.categories c ON c.id=e.category_id WHERE e.family_id=$1 AND e.id=$2', [familyId,id]);
  return result.rows[0] ? (await withItems(db, familyId, [dto(result.rows[0])]))[0] : null;
}
// shortcut: sin paginación, paginar al pasar de ~5000 gastos
// author: limita a lo que registró ese integrante (ver visibleAuthor); undefined = sin límite.
export async function listExpenses(db: Connection, familyId: string, query: ExpenseFilters = {}, author?: string): Promise<ApiExpense[]> {
  const args: unknown[] = [familyId];
  let filters = '';
  if (author) { args.push(author); filters += ' AND e.reported_by_member_id=$' + args.length; }
  if (query.scope) filters += query.scope === 'none' ? ' AND e.scope IS NULL' : (args.push(query.scope), ' AND e.scope=$' + args.length);
  if (query.month) {
    args.push(query.month + '-01');
    filters += ' AND e.date >= $' + args.length + '::date AND e.date < ($' + args.length + '::date + INTERVAL \'1 month\')';
  }
  // Categoría: coincide si es la del gasto o la de alguno de sus conceptos.
  if(query.categoryId){args.push(query.categoryId);filters+=' AND (e.category_id=$'+args.length+' OR EXISTS(SELECT 1 FROM appgastos.expense_items i WHERE i.expense_id=e.id AND i.category_id=$'+args.length+'))';}
  for(const [field,column] of [
    ['currency','currency'],['paymentMethod','payment_method'],
    ['cardId','card_id'],['reportedByMemberId','reported_by_member_id'],
  ] as const)if(query[field]){args.push(query[field]);filters+=' AND e.'+column+'=$'+args.length;}
  if(query.merchant){args.push(query.merchant);filters+=' AND strpos(lower(COALESCE(e.merchant,\'\')),lower($'+args.length+'))>0';}
  const result = await db.query('SELECT ' + columns + ' FROM appgastos.expenses e JOIN appgastos.categories c ON c.id=e.category_id WHERE e.family_id=$1' + filters + ' ORDER BY e.date DESC,e.created_at DESC,e.id',args);
  return withItems(db, familyId, result.rows.map(dto));
}
function values(input: ExpenseWrite): unknown[] {
  return [input.date,input.amount,input.currency,input.merchant,input.description,input.categoryId,input.paymentMethod,input.cardId,input.reportedByMemberId,input.scope ?? null];
}
export async function insertExpense(db: Connection, familyId: string, input: ExpenseWrite, source: 'manual' | 'whatsapp'): Promise<ApiExpense> {
  const result = await db.query('INSERT INTO appgastos.expenses (family_id,date,amount,currency,merchant,description,category_id,payment_method,card_id,reported_by_member_id,scope,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',[familyId,...values(input),source]);
  return (await findExpense(db,familyId,result.rows[0].id))!;
}
export async function updateExpense(db: Connection, familyId: string, id: string, input: ExpenseWrite): Promise<ApiExpense> {
  await db.query('UPDATE appgastos.expenses SET date=$3,amount=$4,currency=$5,merchant=$6,description=$7,category_id=$8,payment_method=$9,card_id=$10,reported_by_member_id=$11,scope=$12 WHERE family_id=$1 AND id=$2',[familyId,id,...values(input)]);
  return (await findExpense(db,familyId,id))!;
}
export async function listCategories(db: Connection, familyId: string) {
  return (await db.query('SELECT id,family_id AS "familyId",name,active,created_at AS "createdAt" FROM appgastos.categories WHERE family_id=$1 ORDER BY name,id',[familyId])).rows;
}
