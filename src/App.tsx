/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { FinanceProvider, useFinance } from './context/FinanceContext';
import { FamilyManagementView } from './components/FamilyManagementView';
import { Navbar } from './components/Navbar';
import { DashboardView } from './components/DashboardView';
import { CalendarView } from './components/CalendarView';
import { ExpensesView } from './components/ExpensesView';
import { AnalysisView } from './components/AnalysisView';
import { AddExpenseModal } from './components/AddExpenseModal';

export function AppContent() {
  const {isDemoMode}=useFinance();
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [isAddExpenseOpen, setIsAddExpenseOpen] = useState<boolean>(false);

  return (
    <div className="min-h-screen bg-slate-50/80 text-slate-900 flex flex-col font-sans">
      
      {/* Barra de Navegación Superior */}
      <Navbar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
      />

      {/* Contenedor Principal de Vistas */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {currentTab === 'dashboard' && (
          <DashboardView
            onNavigateTab={setCurrentTab}
            onOpenAddExpense={() => setIsAddExpenseOpen(true)}
          />
        )}

        {currentTab === 'calendar' && (isDemoMode ? <CalendarView /> : <p>Calendario y vencimientos preservados en modo demo; fuera de prioridad actual.</p>)}

        {currentTab==='family'&&!isDemoMode&&<FamilyManagementView/>}

        {currentTab === 'expenses' && (
          <ExpensesView onOpenAddExpense={() => setIsAddExpenseOpen(true)} />
        )}

        {currentTab === 'analysis' && (isDemoMode ? <AnalysisView /> : <p>Análisis anteriores y compensaciones preservados en modo demo; fuera de prioridad actual.</p>)}
      </main>

      {/* Pie de Página Editorial y Discreto */}
      <footer className="border-t border-slate-200/80 bg-white py-5 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-800">GastosFamilia</span>
            <span>·</span>
            <span>Finanzas del Hogar & WhatsApp Conectar</span>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setCurrentTab('calendar')}
              className="hover:text-blue-600 transition-colors cursor-pointer"
            >
              Vencimientos & Tarjetas
            </button>
            <button
              onClick={() => setCurrentTab('expenses')}
              className="hover:text-blue-600 transition-colors cursor-pointer"
            >
              Historial de Gastos
            </button>
            <button
              onClick={() => setCurrentTab('analysis')}
              className="hover:text-blue-600 transition-colors cursor-pointer"
            >
              Patrones & Balances
            </button>
          </div>
        </div>
      </footer>

      {/* Modal Rápido de Nuevo Gasto */}
      <AddExpenseModal
        isOpen={isAddExpenseOpen}
        onClose={() => setIsAddExpenseOpen(false)}
      />

    </div>
  );
}

export default function App() {
  return (
    <FinanceProvider>
      <AppContent />
    </FinanceProvider>
  );
}
