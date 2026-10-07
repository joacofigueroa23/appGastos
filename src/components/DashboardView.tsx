import React from 'react';
import { useFinance } from '../context/FinanceContext';
import {
  TrendingUp,
  AlertTriangle,
  CreditCard,
  Users,
  Calendar,
  CheckCircle2,
  Clock,
  ArrowRight,
  Plus,
  MessageCircle,
} from 'lucide-react';

interface DashboardViewProps {
  onNavigateTab: (tab: string) => void;
  onOpenAddExpense: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  onNavigateTab,
  onOpenAddExpense,
}) => {
  const {
    members,
    expenses,
    bills,
    cards,
    formatCurrency,
    currentMonthSummary,
    toggleBillPaid,
  } = useFinance();

  const now = new Date();
  const currentMonthName = now.toLocaleString('es-AR', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - now.getDate();

  const totalFamilyBudget = members.reduce((acc, m) => acc + m.monthlyBudget, 0);
  const budgetUsedPercent = Math.min(
    Math.round((currentMonthSummary.totalSpent / (totalFamilyBudget || 1)) * 100),
    100
  );

  // Cuotas activas
  const installmentExpenses = expenses.filter((e) => e.installmentTotal > 1);
  const totalInstallmentBurden = installmentExpenses.reduce((acc, e) => {
    return acc + Math.round(e.amount / e.installmentTotal);
  }, 0);

  // Próximos vencimientos ordenados
  const pendingBillsSorted = [...bills]
    .filter((b) => b.status === 'pending')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  // Desglose por categoría
  const categoryTotals: Record<string, number> = {};
  expenses.forEach((e) => {
    categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
  });
  const sortedCategories = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      
      {/* 1. Header Conciso & Amigable */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-3xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 mb-1">
            <span className="capitalize">{currentMonthName}</span>
            <span>·</span>
            <span>{daysRemaining} días restantes</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Control de Gastos del Hogar
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Tarjetas, servicios e ingresos automáticos por WhatsApp al día.
          </p>
        </div>

        {/* Indicador de WhatsApp y Botón rápido */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 text-emerald-800 text-xs font-semibold rounded-2xl border border-emerald-200/70">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <MessageCircle className="w-4 h-4 text-emerald-600" />
            <span>WhatsApp Conectado: +54 9 11 3840-9123</span>
          </div>

          <button
            onClick={onOpenAddExpense}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-2xl transition-all shadow-sm shadow-blue-500/20 cursor-pointer"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>Cargar Gasto</span>
          </button>
        </div>
      </div>

      {/* 2. Cuadrícula de 4 Métricas Clave (Sin saturación visual) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        {/* Métrica 1: Gasto Total */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs space-y-2">
          <span className="text-xs font-semibold text-slate-500 block">Total Gastado este Mes</span>
          <div className="text-2xl font-extrabold font-mono text-slate-900 tracking-tight tabular-nums">
            {formatCurrency(currentMonthSummary.totalSpent)}
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
            <span>{budgetUsedPercent}% del presupuesto</span>
            <span className="font-medium text-slate-700">{formatCurrency(totalFamilyBudget)}</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                budgetUsedPercent > 85 ? 'bg-red-500' : budgetUsedPercent > 65 ? 'bg-amber-500' : 'bg-blue-600'
              }`}
              style={{ width: `${budgetUsedPercent}%` }}
            />
          </div>
        </div>

        {/* Métrica 2: Gastos Comunes */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs space-y-2">
          <span className="text-xs font-semibold text-slate-500 block">Gastos Comunes del Hogar</span>
          <div className="text-2xl font-extrabold font-mono text-emerald-600 tracking-tight tabular-nums">
            {formatCurrency(currentMonthSummary.sharedTotal)}
          </div>
          <div className="text-[11px] text-slate-500 pt-1 flex items-center justify-between">
            <span>Personales individuales:</span>
            <span className="font-mono font-semibold text-slate-700">{formatCurrency(currentMonthSummary.personalTotal)}</span>
          </div>
        </div>

        {/* Métrica 3: Vencimientos Pendientes */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs space-y-2">
          <span className="text-xs font-semibold text-slate-500 block">Facturas & Vencimientos</span>
          <div className="text-2xl font-extrabold font-mono text-amber-600 tracking-tight tabular-nums">
            {formatCurrency(currentMonthSummary.totalPendingBills)}
          </div>
          <div className="text-[11px] text-slate-500 pt-1 flex items-center justify-between">
            <span>{currentMonthSummary.nextVencimientosCount} cuentas por abonar</span>
            <button
              onClick={() => onNavigateTab('calendar')}
              className="text-blue-600 font-semibold hover:underline cursor-pointer"
            >
              Ver calendario
            </button>
          </div>
        </div>

        {/* Métrica 4: Cuotas Fijas Activas */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-2xs space-y-2">
          <span className="text-xs font-semibold text-slate-500 block">Compromiso en Cuotas</span>
          <div className="text-2xl font-extrabold font-mono text-purple-600 tracking-tight tabular-nums">
            {formatCurrency(totalInstallmentBurden)}
          </div>
          <div className="text-[11px] text-slate-500 pt-1 flex items-center justify-between">
            <span>{installmentExpenses.length} compras en cuotas</span>
            <button
              onClick={() => onNavigateTab('expenses')}
              className="text-blue-600 font-semibold hover:underline cursor-pointer"
            >
              Ver cuotas
            </button>
          </div>
        </div>

      </div>

      {/* 3. Dos Columnas Equilibradas: Vencimientos Inmediatos y Categorías */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Columna Izquierda: Vencimientos Próximos de Tarjetas y Servicios */}
        <div className="bg-white rounded-3xl border border-slate-200/80 p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Próximos Vencimientos Inmediatos
              </h2>
              <p className="text-xs text-slate-500">Cuentas y resúmenes de tarjetas que vencen pronto</p>
            </div>
            <button
              onClick={() => onNavigateTab('calendar')}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 cursor-pointer"
            >
              <span>Ver agenda</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="divide-y divide-slate-100">
            {pendingBillsSorted.slice(0, 4).map((bill) => {
              const due = new Date(bill.dueDate);
              const diffDays = Math.ceil(
                (due.getTime() - now.getTime()) / (1000 * 3600 * 24)
              );
              const isUrgent = diffDays <= 3;
              const isWarning = diffDays <= 7;

              return (
                <div
                  key={bill.id}
                  className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        isUrgent
                          ? 'bg-red-500'
                          : isWarning
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-900 truncate">
                        {bill.title}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        Vence: {bill.dueDate}{' '}
                        {diffDays <= 0 ? (
                          <strong className="text-red-600">· ¡Vence hoy!</strong>
                        ) : (
                          <span>· en {diffDays} días</span>
                        )}
                        {bill.autoDebit && <span className="text-blue-600"> · Débito auto</span>}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <span className="text-xs font-bold font-mono text-slate-900 tabular-nums">
                      {formatCurrency(bill.amount)}
                    </span>
                    <button
                      onClick={() => toggleBillPaid(bill.id)}
                      className="px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors cursor-pointer"
                    >
                      Pagar
                    </button>
                  </div>
                </div>
              );
            })}

            {pendingBillsSorted.length === 0 && (
              <div className="py-6 text-center text-slate-400 text-xs">
                🎉 ¡Todas las cuentas del mes están al día!
              </div>
            )}
          </div>

          {/* Resumen de Tarjetas de la Familia */}
          <div className="pt-3 border-t border-slate-100">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
              Tarjetas · Días de Cierre y Vencimiento
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {cards.map((c) => (
                <div key={c.id} className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/60 text-[11px]">
                  <p className="font-bold text-slate-800 truncate">{c.name}</p>
                  <p className="text-slate-500 mt-0.5">
                    Cierre: <strong>Día {c.closingDay}</strong> · Vence: <strong className="text-amber-700">Día {c.dueDay}</strong>
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Columna Derecha: Desglose por Categoría y Presupuesto por Integrante */}
        <div className="bg-white rounded-3xl border border-slate-200/80 p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Gastos por Categoría
              </h2>
              <p className="text-xs text-slate-500">Distribución de lo gastado en el mes</p>
            </div>
            <button
              onClick={() => onNavigateTab('expenses')}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 cursor-pointer"
            >
              <span>Ver todos</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-3">
            {sortedCategories.slice(0, 5).map(([category, amount]) => {
              const pct = currentMonthSummary.totalSpent
                ? Math.round((amount / currentMonthSummary.totalSpent) * 100)
                : 0;
              return (
                <div key={category} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-700">{category}</span>
                    <span className="font-mono font-bold text-slate-900">
                      {formatCurrency(amount)}{' '}
                      <span className="text-slate-400 font-normal">({pct}%)</span>
                    </span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-blue-600 h-full rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Presupuesto por Miembro Familiar */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
              Participación Familiar
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {members.map((m) => {
                const memExpenses = expenses.filter((e) => e.paidByMemberId === m.id);
                const memTotal = memExpenses.reduce((acc, e) => acc + e.amount, 0);
                return (
                  <div key={m.id} className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/60 text-center space-y-1">
                    <span className="text-base select-none">{m.avatar}</span>
                    <p className="text-[11px] font-bold text-slate-800 truncate">{m.name.split(' ')[0]}</p>
                    <p className="text-[10px] font-mono text-slate-600">{formatCurrency(memTotal)}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

      </div>

    </div>
  );
};
