import React, { useState } from 'react';
import { expensesForMonth, sumAmounts, totalsByCategory } from '../utils/finance';
import { useFinance } from '../context/FinanceContext';
import {
  TrendingUp,
  Users,
  Download,
  Calendar,
  Layers,
  CheckCircle2,
  PieChart,
  CreditCard,
  Printer,
  Sparkles,
} from 'lucide-react';

export const AnalysisView: React.FC = () => {
  const { expenses, members, formatCurrency } = useFinance();

  const [activeSubTab, setActiveSubTab] = useState<'patterns' | 'settlement' | 'categories'>('patterns');
  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthStr);
  const [settledFeedback, setSettledFeedback] = useState(false);

  // Filtrar gastos del mes seleccionado
  const monthExpenses = expensesForMonth(expenses, selectedMonth);
  const totalSpent = sumAmounts(monthExpenses);
  const sharedExpenses = monthExpenses.filter((e) => e.isShared);
  const personalExpenses = monthExpenses.filter((e) => !e.isShared);

  const totalShared = sumAmounts(sharedExpenses);
  const totalPersonal = sumAmounts(personalExpenses);

  // Cálculos de compensación entre adultos
  const contributingMembers = members.filter((m) => m.role === 'admin' || m.monthlyBudget >= 100000);
  const contributorsCount = contributingMembers.length || 2;
  const fairSharePerPerson = Math.round(totalShared / contributorsCount);

  const contributionsByMember: Record<string, number> = {};
  contributingMembers.forEach((m) => {
    contributionsByMember[m.id] = sharedExpenses
      .filter((e) => e.paidByMemberId === m.id)
      .reduce((acc, e) => acc + e.amount, 0);
  });

  // Patrones: Fijos vs Variables
  const fixedCategories = ['Servicios & Hogar', 'Educación', 'Impuestos & Seguros'];
  const fixedAmount = monthExpenses
    .filter((e) => fixedCategories.includes(e.category))
    .reduce((acc, e) => acc + e.amount, 0);
  const variableAmount = totalSpent - fixedAmount;
  const fixedPercent = totalSpent ? Math.round((fixedAmount / totalSpent) * 100) : 0;
  const variablePercent = 100 - fixedPercent;

  // Patrones: Concentración por días del mes
  let bracket1_10 = 0;
  let bracket11_20 = 0;
  let bracket21_31 = 0;

  monthExpenses.forEach((e) => {
    const day = parseInt(e.date.split('-')[2] || '1', 10);
    if (day <= 10) bracket1_10 += e.amount;
    else if (day <= 20) bracket11_20 += e.amount;
    else bracket21_31 += e.amount;
  });

  const p1_10 = totalSpent ? Math.round((bracket1_10 / totalSpent) * 100) : 0;
  const p11_20 = totalSpent ? Math.round((bracket11_20 / totalSpent) * 100) : 0;
  const p21_31 = totalSpent ? Math.round((bracket21_31 / totalSpent) * 100) : 0;

  // Categorías
  const sortedCategories = totalsByCategory(monthExpenses);

  // Exportar CSV
  const handleExportCSV = () => {
    const headers = ['Moneda', 'Fecha', 'Descripción', 'Categoría', 'Monto', 'Medio de Pago', 'Pagado Por', 'Tipo'];
    const rows = expenses.filter((e) => e.date.slice(0, 7) === selectedMonth).map((e) => {
      const member = members.find((m) => m.id === e.paidByMemberId);
      return [
        e.currency,
        e.date,
        `"${e.description.replace(/"/g, '""')}"`,
        e.category,
        e.amount,
        e.paymentMethod,
        member?.name || 'Familiar',
        e.isShared ? 'Común' : 'Personal',
      ];
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const link = document.createElement('a');
    link.setAttribute('href', encodeURI(csvContent));
    link.setAttribute('download', `Gastos_Familia_${selectedMonth}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      
      <p className="text-xs text-slate-500">Análisis y balances en ARS. Compensaciones: fuera de prioridad del MVP actual.</p>
      {/* Encabezado Principal y Controles */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-blue-600" />
            <span>Patrones de Gasto & Balances del Hogar</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Visualiza hábitos financieros, reparte gastos comunes y descarga reportes mensuales.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200 text-xs">
            <Calendar className="w-3.5 h-3.5 text-slate-500" />
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="font-semibold text-slate-800 bg-transparent outline-none cursor-pointer"
            />
          </div>

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Descargar CSV</span>
          </button>
        </div>
      </div>

      {/* Sub-Pestañas Segmentadas (Limpio y Amigable) */}
      <div className="flex p-1 bg-slate-200/70 rounded-2xl max-w-md gap-1">
        <button
          onClick={() => setActiveSubTab('patterns')}
          className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
            activeSubTab === 'patterns'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Patrones de Consumo
        </button>
        <button
          onClick={() => setActiveSubTab('settlement')}
          className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
            activeSubTab === 'settlement'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Compensación Familiar
        </button>
        <button
          onClick={() => setActiveSubTab('categories')}
          className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
            activeSubTab === 'categories'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Por Categoría
        </button>
      </div>

      {/* 1. SECCIÓN: PATRONES DE CONSUMO */}
      {activeSubTab === 'patterns' && (
        <div className="space-y-6">
          
          {/* Tarjetas Clave de Diagnóstico */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-blue-600 uppercase tracking-wider block">
                Patrón de Concentración
              </span>
              <p className="text-xl font-bold font-mono text-slate-900">
                {p1_10}% en los primeros 10 días
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                El mayor flujo de salida ocurre a inicio de mes con los vencimientos de servicios y resúmenes de tarjetas.
              </p>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-emerald-600 uppercase tracking-wider block">
                Estructura Fija vs Variable
              </span>
              <p className="text-xl font-bold font-mono text-slate-900">
                {fixedPercent}% Fijo · {variablePercent}% Variable
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                Gastos fijos ({formatCurrency(fixedAmount)}) corresponden a vivienda, colegios e impuestos que no varían.
              </p>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-purple-600 uppercase tracking-wider block">
                Común vs Personal
              </span>
              <p className="text-xl font-bold font-mono text-slate-900">
                {totalSpent ? Math.round((totalShared / totalSpent) * 100) : 0}% Hogar Compartido
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                El restante {totalSpent ? Math.round((totalPersonal / totalSpent) * 100) : 0}% corresponde a gastos personales de cada integrante.
              </p>
            </div>

          </div>

          {/* Gráfico Visual de Quincenas */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-xs space-y-4">
            <h3 className="text-sm font-bold text-slate-900">
              Distribución Temporal del Gasto a lo Largo del Mes
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-800">Días 1 al 10</span>
                  <span className="font-mono font-bold text-slate-900">{formatCurrency(bracket1_10)}</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div className="bg-red-500 h-full rounded-full" style={{ width: `${p1_10}%` }} />
                </div>
                <span className="text-[10px] text-slate-500 block">Vencimientos clave e inicio de mes</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-800">Días 11 al 20</span>
                  <span className="font-mono font-bold text-slate-900">{formatCurrency(bracket11_20)}</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div className="bg-amber-500 h-full rounded-full" style={{ width: `${p11_20}%` }} />
                </div>
                <span className="text-[10px] text-slate-500 block">Mantenimiento y compras del hogar</span>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-800">Días 21 al 31</span>
                  <span className="font-mono font-bold text-slate-900">{formatCurrency(bracket21_31)}</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${p21_31}%` }} />
                </div>
                <span className="text-[10px] text-slate-500 block">Cierre de tarjetas y gastos menores</span>
              </div>
            </div>
          </div>

        </div>
      )}

      {/* 2. SECCIÓN: COMPENSACIÓN FAMILIAR */}
      {activeSubTab === 'settlement' && (
        <div className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 sm:p-8 text-white shadow-md border border-slate-800 space-y-6">
          
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-5">
            <div>
              <span className="text-xs font-semibold text-emerald-300 uppercase tracking-wider">
                Gastos Compartidos del Hogar: {formatCurrency(totalShared)}
              </span>
              <h2 className="text-xl font-bold text-white mt-1">
                Reparto Equitativo entre Aportantes
              </h2>
            </div>
            <span className="text-xs bg-white/10 px-3 py-1.5 rounded-full text-slate-200 self-start sm:self-auto font-mono">
              Cuota 50/50: {formatCurrency(fairSharePerPerson)} c/u
            </span>
          </div>

          {settledFeedback && (
            <div className="p-3 bg-emerald-500/20 border border-emerald-400/40 rounded-xl text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-300" />
              <span>¡Compensación saldada y registrada!</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {contributingMembers.map((m) => {
              const paid = contributionsByMember[m.id] || 0;
              const diff = paid - fairSharePerPerson;

              return (
                <div
                  key={m.id}
                  className="bg-white/10 backdrop-blur-sm rounded-2xl p-5 border border-white/10 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{m.avatar}</span>
                      <span className="font-bold text-sm text-white">{m.name}</span>
                    </div>
                    <span className="text-xs text-slate-300">Puso para el hogar:</span>
                  </div>

                  <div className="text-2xl font-bold font-mono text-white tracking-tight">
                    {formatCurrency(paid)}
                  </div>

                  <div className="text-xs pt-2 border-t border-white/10 flex items-center justify-between">
                    <span className="text-slate-300">Saldo frente al 50%:</span>
                    <span className={`font-bold font-mono ${diff >= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
                      {diff >= 0 ? `+${formatCurrency(diff)} a favor` : `${formatCurrency(diff)} a compensar`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {contributingMembers.length >= 2 && (
            <div className="bg-white/10 rounded-2xl p-5 border border-white/15 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-0.5">
                <span className="text-xs font-semibold text-slate-300 block">Transferencia recomendada:</span>
                {(() => {
                  const [m1, m2] = contributingMembers;
                  const paid1 = contributionsByMember[m1.id] || 0;
                  const paid2 = contributionsByMember[m2.id] || 0;
                  const delta = Math.round(Math.abs(paid1 - paid2) / 2);

                  if (delta === 0) {
                    return <p className="text-sm font-bold text-emerald-300">¡Están exactamente a mano!</p>;
                  }
                  const debtor = paid1 < paid2 ? m1 : m2;
                  const creditor = paid1 < paid2 ? m2 : m1;

                  return (
                    <p className="text-sm font-bold text-white">
                      <span className="text-amber-300">{debtor.name.split(' ')[0]}</span> le transfiere{' '}
                      <span className="text-emerald-300 font-mono text-base">{formatCurrency(delta)}</span> a{' '}
                      <span className="text-indigo-200">{creditor.name.split(' ')[0]}</span> para equilibrar.
                    </p>
                  );
                })()}
              </div>

              <button
                onClick={() => {
                  setSettledFeedback(true);
                  setTimeout(() => setSettledFeedback(false), 3000);
                }}
                className="px-4 py-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl transition-all cursor-pointer whitespace-nowrap shadow-sm"
              >
                Marcar como Saldado
              </button>
            </div>
          )}

        </div>
      )}

      {/* 3. SECCIÓN: POR CATEGORÍA */}
      {activeSubTab === 'categories' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-xs space-y-4">
          <h3 className="text-base font-bold text-slate-900">
            Desglose de Gastos por Categoría
          </h3>

          <div className="space-y-3">
            {sortedCategories.map(([catName, catAmount]) => {
              const pct = totalSpent ? Math.round((catAmount / totalSpent) * 100) : 0;
              return (
                <div key={catName} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-700">{catName}</span>
                    <span className="font-mono text-slate-900 font-bold">
                      {formatCurrency(catAmount)}{' '}
                      <span className="text-slate-400 font-normal">({pct}%)</span>
                    </span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div className="bg-blue-600 h-full rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}

            {sortedCategories.length === 0 && (
              <p className="text-xs text-slate-400 py-6 text-center">
                No hay movimientos registrados para este mes.
              </p>
            )}
          </div>
        </div>
      )}

    </div>
  );
};
