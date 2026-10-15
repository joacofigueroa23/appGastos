import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPENSE_CATEGORIES } from '../src/data/financeCatalog';
import { dateOnlyDayDifference, expensesForMonth, isDateOnly, manualExpenseFromFields,
  parseAmountInput, persistExpenseList, selectableCards, sumAmounts, todayDateOnly,
  totalsByCategory, totalsByCurrency, validateExpense } from '../src/utils/finance';
import type { Expense } from '../src/types';
const fields = {
  description: 'Compra familiar', amount: '1234.56', date: '2026-10-08',
  category: 'Supermercado', paymentMethod: 'Tarjeta de Crédito', cardId: '',
  reportedByMemberId: 'member-1', installmentTotal: 1, installmentCurrent: 1, notes: '',
};
const expense = (overrides: Partial<Expense> = {}): Expense => ({
  ...manualExpenseFromFields(fields, []), id: 'exp-1', createdAt: '2026-10-08T12:00:00Z', ...overrides,
});
test('1234.56 conserva decimales en registro y JSON', () => {
  assert.equal(expense().amount, 1234.56);
  assert.equal(JSON.parse(JSON.stringify(expense())).amount, 1234.56);
  assert.equal(parseAmountInput('1234,56'), 1234.56);
  for (const invalid of ['', '1.234,56', '12abc', 'Infinity', '1.234', '-5', '1e3']) {
    assert.ok(Number.isNaN(parseAmountInput(invalid)), invalid);
  }
});
test('se rechazan cero, negativos, no finitos y exceso de decimales', () => {
  for (const amount of [0, -1, Infinity, NaN, 1.234]) assert.throws(() => validateExpense({ ...expense(), amount }));
});
test('fecha literal y validación de calendario independiente de zona', () => {
  assert.equal(expense().date, '2026-10-08');
  assert.equal(dateOnlyDayDifference('2026-10-08', '2026-10-07'), 1);
  assert.equal(dateOnlyDayDifference('2026-11-01', '2026-10-31'), 1);
  assert.equal(dateOnlyDayDifference('2026-10-08', '2026-10-08'), 0);
  assert.ok(isDateOnly('2024-02-29'));
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-08T00:00:00Z']) assert.equal(isDateOnly(invalid), false);
  assert.equal(todayDateOnly(new Date(2026, 9, 8, 23, 30)), '2026-10-08');
});
test('tarjeta opcional, selección explícita y compatibilidad anterior', () => {
  const cards = [{ id: 'card-2', name: 'Primera', active: true }, { id: 'card-1', name: 'Elegida', active: true }];
  assert.equal(manualExpenseFromFields(fields, cards).cardId, undefined);
  assert.equal(manualExpenseFromFields({ ...fields, cardId: 'card-1' }, cards).cardId, 'card-1');
  assert.equal(manualExpenseFromFields({ ...fields, paymentMethod: 'Tarjeta de Débito', cardId: 'card-1' }, cards).cardId, 'card-1');
  assert.throws(() => manualExpenseFromFields({ ...fields, cardId: 'missing' }, cards));
  assert.throws(() => manualExpenseFromFields({ ...fields, cardId: 'card-1' }, [{ ...cards[1], active: false }]));
  assert.equal(manualExpenseFromFields({ ...fields, paymentMethod: 'Efectivo', cardId: 'card-1' }, cards).cardId, undefined);
  assert.deepEqual(selectableCards([{ id: 'old', name: 'Anterior' }, { id: 'off', name: 'Inactiva', active: false }]),
    [{ id: 'old', name: 'Anterior', active: true }]);
});
test('categoría, pago e integrante explícitos; nuevos registros familiares ARS', () => {
  for (const key of ['category', 'paymentMethod', 'reportedByMemberId'] as const) assert.throws(() => manualExpenseFromFields({ ...fields, [key]: '' }, []));
  for (const category of EXPENSE_CATEGORIES) assert.equal(manualExpenseFromFields({ ...fields, category }, []).category, category);
  assert.equal(expense().reportedByMemberId, 'member-1');
  assert.equal(expense().isShared, true);
  assert.equal(expense().currency, 'ARS');
});
test('cuotas incoherentes se rechazan; efectivo no conserva cuotas previas', () => {
  assert.throws(() => manualExpenseFromFields({ ...fields, installmentTotal: 2, installmentCurrent: 3 }, []));
  const result = manualExpenseFromFields({ ...fields, paymentMethod: 'Efectivo', installmentTotal: 6, installmentCurrent: 3 }, []);
  assert.equal(result.installmentTotal, 1);
  assert.equal(result.installmentCurrent, 1);
});
test('totales y categorías comparten mes y moneda con centavos exactos', () => {
  const records = [expense({ amount: 0.1 }), expense({ id: 'two', amount: 0.2, category: 'Mascotas' }),
    expense({ id: 'old', amount: 900, date: '2026-09-30' }), expense({ id: 'usd', amount: 10, currency: 'USD' })];
  const month = expensesForMonth(records, '2026-10');
  assert.equal(month.length, 2);
  assert.equal(sumAmounts(month), 0.3);
  assert.equal(sumAmounts(totalsByCategory(month).map(([, amount]) => ({ amount }))), 0.3);
  assert.deepEqual(totalsByCurrency(records), [['ARS', 900.3], ['USD', 10]]);
  assert.deepEqual(expensesForMonth(records, ''), []);
});
test('fallo de almacenamiento se informa; guardado conserva monto y fecha', () => {
  assert.throws(() => persistExpenseList({ setItem() { throw new Error('QuotaExceededError'); } }, [expense()]), /No se pudo guardar/);
  let saved = '';
  persistExpenseList({ setItem(key, value) { assert.equal(key, 'gf_expenses'); saved = value; } }, [expense()]);
  assert.equal(JSON.parse(saved)[0].amount, 1234.56);
  assert.equal(JSON.parse(saved)[0].date, '2026-10-08');
});
