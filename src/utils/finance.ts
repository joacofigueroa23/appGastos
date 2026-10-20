import { EXPENSE_CATEGORIES, PAYMENT_METHODS, PRIMARY_CURRENCY } from '../data/financeCatalog';
import type { CardIdentity, CreditCard, Expense } from '../types';
export type ExpenseInput = Omit<Expense, 'id' | 'createdAt'>;

// Número HTML sin separadores de miles: el punto es decimal.
export function parseAmountInput(value: string): number {
  const input = value.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(input)) return NaN;
  const amount = Number(input.replace(',', '.'));
  return Number.isFinite(amount) && Number.isSafeInteger(Math.round(amount * 100)) ? amount : NaN;
}
// Huella barata de una lista de gastos (cantidad + última modificación). El panel sondea la API cada 10 s y entrega una lista
// nueva aunque nada cambie: los efectos que dependen de los gastos usan esta huella para no repetir pedidos.
export function expensesStamp(list: readonly { updatedAt?: string }[] = []): string {
  return list.length + ':' + list.reduce((latest, e) => (e.updatedAt && e.updatedAt > latest ? e.updatedAt : latest), '');
}
export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
export function todayDateOnly(now = new Date()): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
}
export function dateOnlyDayDifference(date: string, reference: string): number {
  if (!isDateOnly(date) || !isDateOnly(reference)) return NaN;
  const ordinal = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    const result = new Date(0);
    result.setUTCFullYear(year, month - 1, day);
    result.setUTCHours(0, 0, 0, 0);
    return result.getTime() / 86400000;
  };
  return ordinal(date) - ordinal(reference);
}
export function expensesForMonth(expenses: Expense[], month: string, currency = PRIMARY_CURRENCY): Expense[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  return expenses.filter((e) => e.currency === currency && isDateOnly(e.date) && e.date.slice(0, 7) === month);
}
export function sumAmounts(items: { amount: number }[]): number {
  return items.reduce((cents, item) => cents + Math.round(item.amount * 100), 0) / 100;
}
export function totalsByCurrency(expenses: Expense[]): [string, number][] {
  const groups = new Map<string, Expense[]>();
  expenses.forEach((e) => { const group = groups.get(e.currency) || []; group.push(e); groups.set(e.currency, group); });
  return [...groups].map(([currency, group]) => [currency, sumAmounts(group)]);
}
export function totalsByCategory(expenses: Expense[]): [string, number][] {
  const groups = new Map<string, Expense[]>(EXPENSE_CATEGORIES.map((c) => [c, [] as Expense[]]));
  expenses.forEach((e) => { const group = groups.get(e.category) || []; group.push(e); groups.set(e.category, group); });
  return [...groups].filter(([, group]) => group.length)
    .map(([category, group]): [string, number] => [category, sumAmounts(group)]).sort((a, b) => b[1] - a[1]);
}
export function selectableCards(cards: Pick<CreditCard, 'id' | 'name' | 'active'>[]): CardIdentity[] {
  return cards.filter((c) => c.active !== false).map((c) => ({ id: c.id, name: c.name, active: true }));
}
export function validateExpense(input: ExpenseInput): void {
  if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('Completa la descripción.');
  if (!Number.isFinite(input.amount) || input.amount <= 0 ||
      !Number.isSafeInteger(Math.round(input.amount * 100)) ||
      Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.00001) {
    throw new Error('Ingresa un monto positivo con hasta dos decimales.');
  }
  if (!isDateOnly(input.date)) throw new Error('Selecciona una fecha válida.');
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('La moneda no es válida.');
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) throw new Error('Selecciona una categoría.');
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)) throw new Error('Selecciona un medio de pago.');
  if (!Number.isInteger(input.installmentTotal) || !Number.isInteger(input.installmentCurrent) ||
      input.installmentTotal < 1 || input.installmentCurrent < 1 ||
      input.installmentCurrent > input.installmentTotal) throw new Error('Revisa la cantidad y la cuota actual.');
}
export interface ManualExpenseFields {
  description: string; amount: string; date: string; category: string; paymentMethod: string;
  cardId: string; reportedByMemberId: string; installmentTotal: number; installmentCurrent: number; notes: string;
}
export function manualExpenseFromFields(fields: ManualExpenseFields, cards: CardIdentity[]): ExpenseInput {
  const usesCard = fields.paymentMethod === 'Tarjeta de Crédito' || fields.paymentMethod === 'Tarjeta de Débito';
  if (!fields.reportedByMemberId) throw new Error('Selecciona quién informó el gasto.');
  if (usesCard && fields.cardId && !cards.some((c) => c.id === fields.cardId && c.active)) {
    throw new Error('La tarjeta seleccionada ya no está disponible. Selecciona otra o deja el campo vacío.');
  }
  const credit = fields.paymentMethod === 'Tarjeta de Crédito';
  const expense: ExpenseInput = {
    description: fields.description.trim(), amount: parseAmountInput(fields.amount), currency: PRIMARY_CURRENCY,
    date: fields.date, category: fields.category as Expense['category'],
    paymentMethod: fields.paymentMethod as Expense['paymentMethod'],
    cardId: usesCard && fields.cardId ? fields.cardId : undefined,
    reportedByMemberId: fields.reportedByMemberId,
    // Compatibilidad con las vistas anteriores; no implica cuenta personal ni deuda.
    paidByMemberId: fields.reportedByMemberId, isShared: true,
    installmentTotal: credit ? fields.installmentTotal : 1,
    installmentCurrent: credit ? fields.installmentCurrent : 1,
    notes: fields.notes.trim() || undefined, source: 'manual',
  };
  validateExpense(expense);
  return expense;
}
export function persistExpenseList(storage: Pick<Storage, 'setItem'>, expenses: Expense[]): void {
  try { storage.setItem('gf_expenses', JSON.stringify(expenses)); }
  catch { throw new Error('No se pudo guardar en este navegador. Revisa el espacio o los permisos y vuelve a intentar.'); }
}
