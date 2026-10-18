import type { Pool } from 'pg';
import { validateExpenseWrite } from './validation';
import { ApiError } from '../shared/errors';
import { object, uuid } from '../shared/validators';
import { findExpense, insertExpense, listExpenses, transaction, updateExpense, type Connection } from './repository';
import type { ApiExpense, ExpenseWrite, ExpenseFilters } from '../../shared/apiTypes';

// Cacheado por pool y valor de APP_FAMILY_ID: evita 1-2 consultas por request con pool de 1 conexión.
const resolved = new WeakMap<Pool, { env: string | undefined; id: string }>();
export async function resolveFamilyId(pool: Pool): Promise<string> {
  const env = process.env.APP_FAMILY_ID, cached = resolved.get(pool);
  if (cached && cached.env === env) return cached.id;
  const id = await lookupFamilyId(pool);
  resolved.set(pool, { env, id });
  return id;
}
async function lookupFamilyId(pool: Pool): Promise<string> {
  if (process.env.APP_FAMILY_ID) {
    const id = uuid(process.env.APP_FAMILY_ID, 'APP_FAMILY_ID');
    if (!(await pool.query('SELECT id FROM appgastos.families WHERE id=$1',[id])).rowCount) throw new ApiError(503,'La familia configurada no existe. Ejecuta el seed.');
    return id;
  }
  const result = await pool.query('SELECT id FROM appgastos.families LIMIT 2');
  if (result.rows.length !== 1) throw new ApiError(503,'Configura APP_FAMILY_ID y ejecuta el seed inicial.');
  return result.rows[0].id;
}
async function references(db: Connection, familyId: string, input: ExpenseWrite, previous?: ApiExpense): Promise<void> {
  // Identificadores de tabla definidos por el servidor, nunca por el cliente.
  for (const [table,key] of [['categories','categoryId'],['cards','cardId'],['family_members','reportedByMemberId']] as const) {
    const id = input[key];
    if (!id) continue;
    const result = await db.query('SELECT active' + (table === 'cards' ? ',card_type' : '') + ' FROM appgastos.' + table + ' WHERE family_id=$1 AND id=$2 FOR SHARE',[familyId,id]);
    if (!result.rows[0] || (!result.rows[0].active && previous?.[key] !== id)) throw new ApiError(400,key + ' no existe o está inactivo para esta familia.');
    // Un tipo configurado después no invalida ediciones de gastos históricos que conservan tarjeta y medio.
    const type = result.rows[0].card_type;
    if (type && type !== input.paymentMethod && (previous?.cardId !== id || previous?.paymentMethod !== input.paymentMethod)) throw new ApiError(400,'El medio de pago no coincide con el tipo de la tarjeta.');
  }
}
// Con sesión individual el autor lo define el servidor: es quien creó el gasto y no cambia al editarlo.
// El cliente puede omitir el campo o repetir el valor correcto; cualquier otro se rechaza.
function withAuthor(body: unknown, author: string | undefined, previous?: ApiExpense): unknown {
  if (!author) return body;
  const input = object(body), expected = previous ? previous.reportedByMemberId : author, sent = input.reportedByMemberId;
  if (sent !== undefined && sent !== null && sent !== expected) throw new ApiError(403,'El autor del gasto lo define el servidor y no se puede cambiar.');
  return { ...input, reportedByMemberId: expected };
}
export function expenseService(pool: Pool, familyId: string, author?: string) {
  return {
    list: (filters:ExpenseFilters={}) => listExpenses(pool,familyId,filters),
    async get(id: string) {
      const result = await findExpense(pool,familyId,uuid(id));
      if (!result) throw new ApiError(404,'Gasto inexistente.');
      return result;
    },
    async createExpense(body: unknown, source: 'manual' | 'whatsapp' = 'manual', connection?: Connection) {
      const input = validateExpenseWrite(withAuthor(body,author));
      const create = async (db: Connection) => {
        await references(db,familyId,input);
        return insertExpense(db,familyId,input,source);
      };
      return connection ? create(connection) : transaction(pool,create);
    },
    // connection: transacción del llamador (p. ej. el bot); sin ella se abre una propia.
    async update(id: string, body: unknown, connection?: Connection) {
      uuid(id);
      const run = <T,>(work: (db: Connection) => Promise<T>) => connection ? work(connection) : transaction(pool,work);
      return run(async (db) => {
        await db.query('SELECT id FROM appgastos.expenses WHERE family_id=$1 AND id=$2 FOR UPDATE',[familyId,id]);
        const previous = await findExpense(db,familyId,id);
        if (!previous) throw new ApiError(404,'Gasto inexistente.');
        const input = validateExpenseWrite(withAuthor(body,author,previous),previous);
        await references(db,familyId,input,previous);
        return updateExpense(db,familyId,id,input);
      });
    },
    async delete(id: string) {
      const result = await pool.query('DELETE FROM appgastos.expenses WHERE family_id=$1 AND id=$2',[familyId,uuid(id)]);
      if (!result.rowCount) throw new ApiError(404,'Gasto inexistente.');
    },
  };
}
