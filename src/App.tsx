/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { FinanceProvider, useFinance } from './context/FinanceContext';
import { FamilyManagementView } from './components/FamilyManagementView';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { CalendarView } from './components/CalendarView';
import { ExpensesView } from './components/ExpensesView';
import { AnalysisView } from './components/AnalysisView';
import { AddExpenseModal } from './components/AddExpenseModal';
import { ProfileView } from './components/ProfileView';
import { AuthGate } from './context/AuthContext';

export function AppContent() {
  const {isDemoMode}=useFinance();
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [isAddExpenseOpen, setIsAddExpenseOpen] = useState<boolean>(false);

  return (
    <div className="min-h-screen bg-ground text-ink flex flex-col font-sans">

      <Sidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
      />

      {/* Contenedor Principal de Vistas */}
      <main className="flex-1 w-full md:pl-16 max-md:pb-20">
        <div className="max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 sm:py-10">
        {currentTab === 'dashboard' && (
          <DashboardView
            onNavigateTab={setCurrentTab}
            onOpenAddExpense={() => setIsAddExpenseOpen(true)}
          />
        )}

        {currentTab === 'calendar' && (isDemoMode ? <CalendarView /> : <p>Calendario y vencimientos preservados en modo demo; fuera de prioridad actual.</p>)}

        {currentTab==='family'&&!isDemoMode&&<FamilyManagementView/>}

        {currentTab==='profile'&&<ProfileView/>}

        {currentTab === 'expenses' && (
          <ExpensesView onOpenAddExpense={() => setIsAddExpenseOpen(true)} />
        )}

        {currentTab === 'analysis' && (isDemoMode ? <AnalysisView /> : <p>Análisis anteriores y compensaciones preservados en modo demo; fuera de prioridad actual.</p>)}
        </div>
      </main>

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
    <AuthGate>
      <FinanceProvider>
        <AppContent />
      </FinanceProvider>
    </AuthGate>
  );
}
