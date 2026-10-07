import React, { useState } from 'react';
import { useFinance } from '../context/FinanceContext';
import { ExpenseCategory, PaymentMethod } from '../types';
import {
  Receipt,
  Search,
  Filter,
  Trash2,
  Plus,
  MessageSquare,
  CreditCard,
  Layers,
  ArrowRight,
} from 'lucide-react';

interface ExpensesViewProps {
  onOpenAddExpense: () => void;
}

export const ExpensesView: React.FC<ExpensesViewProps> = ({ onOpenAddExpense }) => {
  const { expenses, members, cards, deleteExpense, formatCurrency } = useFinance();

  const [search, setSearch] = useState('');
  const [selectedMember, setSelectedMember] = useState<string>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all'); // 'all', 'shared', 'personal', 'installments'

  // Filtrado reactivo
  const filteredExpenses = expenses.filter((e) => {
    const matchesSearch =
      e.description.toLowerCase().includes(search.toLowerCase()) ||
      (e.notes && e.notes.toLowerCase().includes(search.toLowerCase()));

    const matchesMember = selectedMember === 'all' || e.paidByMemberId === selectedMember;
    const matchesCategory = selectedCategory === 'all' || e.category === selectedCategory;

    let matchesType = true;
    if (selectedType === 'shared') matchesType = e.isShared;
    if (selectedType === 'personal') matchesType = !e.isShared;
    if (selectedType === 'installments') matchesType = e.installmentTotal > 1;

    return matchesSearch && matchesMember && matchesCategory && matchesType;
  });

  const totalFiltered = filteredExpenses.reduce((acc, curr) => acc + curr.amount, 0);

  // Proyección de Cuotas en Meses Futuros
  const installmentPurchases = expenses.filter((e) => e.installmentTotal > 1);

  // Proyectar para los próximos 4 meses
  const now = new Date();
  const futureMonths = [0, 1, 2, 3].map((offset) => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return {
      offset,
      name: d.toLocaleString('es-AR', { month: 'short', year: 'numeric' }),
      total: 0,
      items: [] as { desc: string; quotaAmount: number; quotaIndex: string }[],
    };
  });

  installmentPurchases.forEach((e) => {
    const quotaAmount = Math.round(e.amount / e.installmentTotal);
    const quotasLeft = e.installmentTotal - e.installmentCurrent;

    futureMonths.forEach((m) => {
      // Si este mes entra dentro de las cuotas restantes
      if (m.offset <= quotasLeft) {
        const thisQuota = e.installmentCurrent + m.offset;
        m.total += quotaAmount;
        m.items.push({
          desc: e.description,
          quotaAmount,
          quotaIndex: `${thisQuota}/${e.installmentTotal}`,
        });
      }
    });
  });

  return (
    <div className="space-y-6">
      
      {/* Encabezado y Acción */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Receipt className="w-6 h-6 text-blue-600" />
            <span>Registro Central de Gastos & Cuotas</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Visualiza todas las transacciones familiares, su origen (WhatsApp o manual) y proyección de cuotas.
          </p>
        </div>

        <button
          onClick={onOpenAddExpense}
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-all shadow-sm shadow-blue-500/20 cursor-pointer self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>+ Cargar Gasto</span>
        </button>
      </div>

      {/* Proyección de Cuotas Futuras (Banner Predictivo) */}
      {installmentPurchases.length > 0 && (
        <div className="bg-slate-900 rounded-2xl p-6 text-white border border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-400" />
              <h2 className="text-base font-bold text-white">
                Proyección de Cuotas en Meses Venideros
              </h2>
            </div>
            <span className="text-xs text-slate-400">
              {installmentPurchases.length} compras en cuotas registradas
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {futureMonths.map((m, idx) => (
              <div
                key={m.name}
                className="bg-slate-800/80 p-3.5 rounded-xl border border-slate-700/60 space-y-1"
              >
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                  {idx === 0 ? 'Este Mes' : m.name}
                </span>
                <span className="text-lg font-bold font-mono text-indigo-300 block">
                  {formatCurrency(m.total)}
                </span>
                <span className="text-[10px] text-slate-400 block">
                  {m.items.length} cuotas fijas activas
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Barra de Búsqueda y Filtros */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          
          {/* Búsqueda por texto */}
          <div className="sm:col-span-1 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
            <input
              type="text"
              placeholder="Buscar por comercio o detalle..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-xs pl-9 pr-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-blue-500"
            />
          </div>

          {/* Filtro por Miembro */}
          <div>
            <select
              aria-label="Filtrar por miembro de la familia"
              value={selectedMember}
              onChange={(e) => setSelectedMember(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none bg-white text-slate-700"
            >
              <option value="all">Todos los miembros</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.avatar} {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Filtro por Categoría */}
          <div>
            <select
              aria-label="Filtrar por categoría de gasto"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none bg-white text-slate-700"
            >
              <option value="all">Todas las categorías</option>
              {[
                'Supermercado',
                'Alimentación & Salidas',
                'Servicios & Hogar',
                'Transporte & Combustible',
                'Salud & Farmacia',
                'Educación',
                'Ocio & Entretenimiento',
                'Ropa & Cuidado Personal',
                'Tecnología & Equipamiento',
              ].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Filtro por Tipo */}
          <div>
            <select
              aria-label="Filtrar por tipo de gasto"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl outline-none bg-white text-slate-700"
            >
              <option value="all">Comunes y Personales</option>
              <option value="shared">Solo Comunes del Hogar</option>
              <option value="personal">Solo Personales</option>
              <option value="installments">Solo en Cuotas</option>
            </select>
          </div>

        </div>

        {/* Resumen de resultados filtrados */}
        <div className="flex items-center justify-between text-xs text-slate-500 pt-1 border-t border-slate-100">
          <span>
            Mostrando <strong>{filteredExpenses.length}</strong> de {expenses.length} gastos
          </span>
          <span>
            Total filtrado:{' '}
            <strong className="text-slate-900 font-mono text-sm">
              {formatCurrency(totalFiltered)}
            </strong>
          </span>
        </div>
      </div>

      {/* Tabla / Lista de Gastos */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="divide-y divide-slate-100">
          
          {filteredExpenses.map((expense) => {
            const member = members.find((m) => m.id === expense.paidByMemberId);
            const card = cards.find((c) => c.id === expense.cardId);

            return (
              <div
                key={expense.id}
                className="p-4 hover:bg-slate-50/70 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                
                {/* Lado izquierdo: Datos del gasto */}
                <div className="flex items-start sm:items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0 text-slate-700">
                    {expense.source === 'whatsapp' ? (
                      <span title="Cargado vía WhatsApp">
                        <MessageSquare className="w-5 h-5 text-emerald-600" />
                      </span>
                    ) : (
                      <Receipt className="w-5 h-5 text-blue-600" />
                    )}
                  </div>

                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-slate-900 truncate">
                        {expense.description}
                      </p>
                      {expense.isShared ? (
                        <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md shrink-0">
                          Común
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md shrink-0">
                          Personal
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{expense.date}</span>
                      <span>·</span>
                      <span className="font-medium text-slate-700">{expense.category}</span>
                      <span>·</span>
                      <span>{expense.paymentMethod}</span>
                      {card && <span>({card.name})</span>}
                      <span>·</span>
                      <span className="font-semibold text-slate-800">
                        {member?.avatar} {member?.name || 'Familiar'}
                      </span>
                    </div>

                    {expense.installmentTotal > 1 && (
                      <div className="flex items-center gap-1.5 text-xs text-purple-700 font-semibold pt-0.5">
                        <CreditCard className="w-3.5 h-3.5" />
                        <span>
                          Cuota {expense.installmentCurrent} de {expense.installmentTotal} (
                          {formatCurrency(Math.round(expense.amount / expense.installmentTotal))} por cuota)
                        </span>
                      </div>
                    )}

                    {expense.notes && (
                      <p className="text-[11px] text-slate-400 italic">
                        Nota: {expense.notes}
                      </p>
                    )}
                  </div>
                </div>

                {/* Lado derecho: Monto y Eliminar */}
                <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 pl-13 sm:pl-0">
                  <div className="text-right">
                    <span className="text-base font-bold font-mono text-slate-900 block tabular-nums">
                      {formatCurrency(expense.amount)}
                    </span>
                    <span className="text-[11px] text-slate-400 uppercase">
                      {expense.source === 'whatsapp' ? 'Vía WhatsApp Bot' : 'Manual'}
                    </span>
                  </div>

                  <button
                    onClick={() => deleteExpense(expense.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                    title="Eliminar gasto"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

              </div>
            );
          })}

          {filteredExpenses.length === 0 && (
            <div className="py-12 text-center text-slate-500 space-y-2">
              <p className="text-sm font-semibold">No se encontraron gastos con los filtros seleccionados.</p>
              <button
                onClick={onOpenAddExpense}
                className="text-xs font-semibold text-blue-600 hover:underline"
              >
                + Cargar el primer gasto
              </button>
            </div>
          )}

        </div>
      </div>

    </div>
  );
};
