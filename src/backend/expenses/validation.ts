import { PAYMENT_CODES, type ExpenseWrite } from '../../shared/apiTypes';
import { isDateOnly } from '../../utils/finance';
import { ApiError } from '../shared/errors';
import { object, text, uuid } from '../shared/validators';
export function normalizeAmount(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new ApiError(400, 'Monto inválido.');
  const raw = String(value);
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) throw new ApiError(400, 'El monto debe ser positivo y tener hasta dos decimales.');
  const [whole, decimals = ''] = raw.split('.');
  if (BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0')) <= 0n) throw new ApiError(400, 'El monto debe ser mayor a cero.');
  return whole + '.' + decimals.padEnd(2, '0');
}
const fields = ['date','amount','currency','merchant','description','categoryId','paymentMethod','cardId','reportedByMemberId','scope'];
export function validateExpenseWrite(value: unknown, previous?: ExpenseWrite): ExpenseWrite {
  const body = object(value);
  if (!Object.keys(body).length) throw new ApiError(400, 'No hay cambios.');
  for (const key of Object.keys(body)) if (!fields.includes(key)) throw new ApiError(400, 'Campo no permitido: ' + key);
  const input = { ...previous, ...body };
  if (typeof input.date !== 'string' || !isDateOnly(input.date)) throw new ApiError(400, 'Fecha inválida: usa YYYY-MM-DD.');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new ApiError(400, 'Moneda inválida.');
  if (!(PAYMENT_CODES as readonly unknown[]).includes(input.paymentMethod)) throw new ApiError(400, 'Medio de pago inválido.');
  const cardId = input.cardId == null ? null : uuid(input.cardId, 'cardId');
  if (cardId && !['debit_card','credit_card'].includes(input.paymentMethod as string)) throw new ApiError(400, 'La tarjeta requiere pago con crédito o débito.');
  // Gasto nuevo: personal salvo que se indique. Un histórico sin clasificar (null) conserva su estado hasta que se clasifique.
  if (input.scope != null && input.scope !== 'personal' && input.scope !== 'household') throw new ApiError(400, "scope debe ser 'personal' o 'household'.");
  const scope = input.scope ?? (previous ? null : 'personal');
  return {
    scope, date: input.date, amount: normalizeAmount(input.amount), currency: input.currency,
    merchant: input.merchant == null ? null : text(input.merchant, 'merchant', 200),
    description: text(input.description, 'description', 1000),
    categoryId: uuid(input.categoryId, 'categoryId'),
    paymentMethod: input.paymentMethod as ExpenseWrite['paymentMethod'], cardId,
    reportedByMemberId: input.reportedByMemberId == null ? null : uuid(input.reportedByMemberId, 'reportedByMemberId'),
  };
}

export function validateExpenseFilters(value:unknown):import('../../shared/apiTypes').ExpenseFilters {
 const query=object(value);
 const fields=['month','currency','categoryId','paymentMethod','cardId','reportedByMemberId','merchant','scope'];
 if(Object.keys(query).some(k=>!fields.includes(k)))throw new ApiError(400,'Filtro no permitido.');
 const out:import('../../shared/apiTypes').ExpenseFilters={};
 if(query.month!==undefined){
  if(typeof query.month!=='string'||!isDateOnly(query.month+'-01'))throw new ApiError(400,'Mes inválido.');
  out.month=query.month;
 }
 if(query.currency!==undefined){
  if(typeof query.currency!=='string'||!(/^[A-Z]{3}$/).test(query.currency))throw new ApiError(400,'Moneda inválida.');
  out.currency=query.currency;
 }
 for(const field of ['categoryId','cardId','reportedByMemberId'] as const)if(query[field]!==undefined)out[field]=uuid(query[field],field);
 if(query.paymentMethod!==undefined){
  if(!(PAYMENT_CODES as readonly unknown[]).includes(query.paymentMethod))throw new ApiError(400,'Medio de pago inválido.');
  out.paymentMethod=query.paymentMethod as import('../../shared/apiTypes').PaymentCode;
 }
 if(query.merchant!==undefined)out.merchant=text(query.merchant,'merchant',200);
 if(query.scope!==undefined){
  if(query.scope!=='personal'&&query.scope!=='household'&&query.scope!=='none')throw new ApiError(400,'Ámbito inválido.');
  out.scope=query.scope;
 }
 return out;
}
