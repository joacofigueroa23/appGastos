import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  FamilyMember,
  CreditCard,
  BillDue,
  Expense,
  WhatsAppLog,
  WhatsAppWebhookConfig,
} from '../types';
import {
  INITIAL_MEMBERS,
  INITIAL_CARDS,
  INITIAL_BILLS,
  INITIAL_EXPENSES,
} from '../data/initialData';

import { PRIMARY_CURRENCY } from '../data/financeCatalog';
import { expensesForMonth, persistExpenseList, sumAmounts, todayDateOnly, validateExpense } from '../utils/finance';

import { DatabaseFinanceProvider } from './DatabaseFinanceProvider';
import type { ApiCard, ApiCategory, ApiExpense, ApiMember, ExpenseWrite, CardWrite, MemberWrite } from '../shared/apiTypes';
interface FinanceContextType {
  isDemoMode: boolean;
  apiExpenses?: ApiExpense[];
  categories?: ApiCategory[];
  apiCards?: ApiCard[];
  apiMembers?: ApiMember[];
  loading?: boolean;
  error?: string | null;
  refresh?: () => Promise<void>;
  createDatabaseExpense?: (input:ExpenseWrite) => Promise<ApiExpense>;
  updateDatabaseExpense?: (id:string,input:Partial<ExpenseWrite>) => Promise<ApiExpense>;
  createDatabaseCard?: (input:CardWrite) => Promise<ApiCard>;
  updateDatabaseCard?: (id:string,input:Partial<CardWrite>) => Promise<ApiCard>;
  createDatabaseMember?: (input:MemberWrite) => Promise<ApiMember>;
  updateDatabaseMember?: (id:string,input:Partial<MemberWrite>) => Promise<ApiMember>;
  members: FamilyMember[];
  activeMemberId: string;
  setActiveMemberId: (id: string) => void;
  cards: CreditCard[];
  bills: BillDue[];
  expenses: Expense[];
  currentMonthExpenses: Expense[];
  whatsappLogs: WhatsAppLog[];
  whatsappConfig: WhatsAppWebhookConfig;
  
  // Acciones de Gastos
  addExpense: (expense: Omit<Expense, 'id' | 'createdAt'>) => void;
  deleteExpense: (id: string) => void | Promise<void>;
  
  // Acciones de Cuentas y Vencimientos
  addBill: (bill: Omit<BillDue, 'id'>) => void;
  toggleBillPaid: (billId: string, memberId?: string) => void;
  deleteBill: (id: string) => void;
  
  // Acciones de Tarjetas
  addCard: (card: Omit<CreditCard, 'id'>) => void;
  deleteCard: (id: string) => void;
  
  // Acciones de Miembros
  addMember: (member: Omit<FamilyMember, 'id'>) => void;
  updateMemberBudget: (id: string, budget: number) => void;
  
  // WhatsApp y Simulación
  saveWhatsAppConfig: (config: WhatsAppWebhookConfig) => Promise<void>;
  simulateWhatsAppMessage: (
    message: string,
    fromMemberId: string,
    imageBase64?: string
  ) => Promise<{ replyMessage: string; success: boolean }>;
  refreshWhatsAppLogs: () => Promise<void>;

  // Métricas calculadas
  formatCurrency: (amount: number, currency?: string) => string;
  currentMonthSummary: {
    totalSpent: number;
    sharedTotal: number;
    personalTotal: number;
    totalPendingBills: number;
    nextVencimientosCount: number;
  };
}

export const FinanceContext = createContext<FinanceContextType | undefined>(undefined);

export const LegacyFinanceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [members, setMembers] = useState<FamilyMember[]>(() => {
    const saved = localStorage.getItem('gf_members');
    return saved ? JSON.parse(saved) : INITIAL_MEMBERS;
  });

  const [activeMemberId, setActiveMemberId] = useState<string>('mem-1');

  const [cards, setCards] = useState<CreditCard[]>(() => {
    const saved = localStorage.getItem('gf_cards');
    return saved ? JSON.parse(saved) : INITIAL_CARDS;
  });

  const [bills, setBills] = useState<BillDue[]>(() => {
    const saved = localStorage.getItem('gf_bills');
    return saved ? JSON.parse(saved) : INITIAL_BILLS;
  });

  const [expenses, setExpenses] = useState<Expense[]>(() => {
    const saved = localStorage.getItem('gf_expenses');
    return saved ? JSON.parse(saved) : INITIAL_EXPENSES;
  });

  const [whatsappLogs, setWhatsappLogs] = useState<WhatsAppLog[]>([]);

  const [whatsappConfig, setWhatsappConfig] = useState<WhatsAppWebhookConfig>({
    verifyToken: '',
    phoneNumberId: '',
    accessToken: '',
    businessAccountId: '',
  });

  // Guardar en localStorage
  useEffect(() => {
    localStorage.setItem('gf_members', JSON.stringify(members));
  }, [members]);

  useEffect(() => {
    localStorage.setItem('gf_cards', JSON.stringify(cards));
  }, [cards]);

  useEffect(() => {
    localStorage.setItem('gf_bills', JSON.stringify(bills));
  }, [bills]);

  // Sincronizar logs y config de WhatsApp con el servidor
  const refreshWhatsAppLogs = async () => {
    try {
      const res = await fetch('/api/whatsapp/logs');
      if (res.ok) {
        const data = await res.json();
        if (data.logs) {
          setWhatsappLogs(data.logs);
        }
      }
    } catch (e) {
      console.warn('Servidor local de logs no disponible temporalmente:', e);
    }
  };

  useEffect(() => {
    refreshWhatsAppLogs();
    // Cargar config del backend
    fetch('/api/whatsapp/config')
      .then((r) => r.json())
      .then((data) => {
        if (data.verifyToken) {
          setWhatsappConfig((prev) => ({
            ...prev,
            verifyToken: data.verifyToken,
            businessAccountId: data.businessAccountId || '',
          }));
        }
      })
      .catch((e) => console.log('Config API en inicio:', e));
  }, []);

  const formatCurrency = (amount: number, currency = PRIMARY_CURRENCY) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const addExpense = (newExpData: Omit<Expense, 'id' | 'createdAt'>) => {
    validateExpense(newExpData);
    const reporter = newExpData.reportedByMemberId || newExpData.paidByMemberId;
    if (!members.some((m) => m.id === reporter)) throw new Error('El integrante seleccionado ya no existe.');
    if (newExpData.cardId && !cards.some((c) => c.id === newExpData.cardId && c.active !== false)) {
      throw new Error('La tarjeta seleccionada ya no está disponible.');
    }
    const newExpense: Expense = {
      ...newExpData,
      id: `exp-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      createdAt: new Date().toISOString(),
    };
    const nextExpenses = [newExpense, ...expenses];
    persistExpenseList(localStorage, nextExpenses);
    setExpenses(nextExpenses);
  };

  const deleteExpense = (id: string) => {
    const nextExpenses = expenses.filter((e) => e.id !== id);
    persistExpenseList(localStorage, nextExpenses);
    setExpenses(nextExpenses);
  };

  const addBill = (billData: Omit<BillDue, 'id'>) => {
    const newBill: BillDue = {
      ...billData,
      id: `bill-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    };
    setBills((prev) => [...prev, newBill]);
  };

  const toggleBillPaid = (billId: string, memberId?: string) => {
    setBills((prev) =>
      prev.map((b) => {
        if (b.id !== billId) return b;
        const isPaid = b.status === 'paid';
        return {
          ...b,
          status: isPaid ? 'pending' : 'paid',
          paidDate: isPaid ? undefined : todayDateOnly(),
          paidByMemberId: isPaid ? undefined : memberId || activeMemberId,
        };
      })
    );
  };

  const deleteBill = (id: string) => {
    setBills((prev) => prev.filter((b) => b.id !== id));
  };

  const addCard = (cardData: Omit<CreditCard, 'id'>) => {
    const newCard: CreditCard = {
      ...cardData,
      active: cardData.active ?? true,
      id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    };
    setCards((prev) => [...prev, newCard]);
  };

  const deleteCard = (id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  const addMember = (memberData: Omit<FamilyMember, 'id'>) => {
    const newMember: FamilyMember = {
      ...memberData,
      id: `mem-${Date.now()}`,
    };
    setMembers((prev) => [...prev, newMember]);
  };

  const updateMemberBudget = (id: string, budget: number) => {
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, monthlyBudget: budget } : m))
    );
  };

  const saveWhatsAppConfig = async (newCfg: WhatsAppWebhookConfig) => {
    setWhatsappConfig(newCfg);
    try {
      await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCfg),
      });
    } catch (e) {
      console.error('Error guardando configuración de WhatsApp en servidor:', e);
    }
  };

  const simulateWhatsAppMessage = async (
    message: string,
    fromMemberId: string,
    imageBase64?: string
  ) => {
    const member = members.find((m) => m.id === fromMemberId) || members[0];
    try {
      const res = await fetch('/api/whatsapp/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          fromNumber: member.phoneNumber || '+54 9 11 1234-5678',
          memberName: member.name,
          imageBase64,
          mimeType: imageBase64 ? 'image/jpeg' : undefined,
        }),
      });

      const data = await res.json();
      if (data.success && data.extractedExpense) {
        const ext = data.extractedExpense;

        // Únicamente una coincidencia inequívoca, nunca una tarjeta predeterminada.
        const matchingCards = cards.filter((c) => c.active !== false && ext.cardName &&
          c.name.toLowerCase() === ext.cardName.toLowerCase());
        const matchedCard = matchingCards.length === 1 ? matchingCards[0] : undefined;

        // Agregar gasto a la lista oficial de la app
        addExpense({
          description: ext.description,
          amount: ext.amount,
          currency: ext.currency,
          category: ext.category,
          date: todayDateOnly(),
          paymentMethod: ext.paymentMethod,
          cardId: matchedCard?.id,
          paidByMemberId: member.id,
          reportedByMemberId: member.id,
          isShared: ext.isShared ?? true,
          installmentTotal: ext.installmentTotal || 1,
          installmentCurrent: ext.installmentCurrent || 1,
          notes: ext.installmentTotal > 1 ? `Cuota 1 de ${ext.installmentTotal}` : undefined,
          source: 'whatsapp',
          whatsappMessage: message,
        });

        await refreshWhatsAppLogs();
        return { replyMessage: data.replyMessage, success: true };
      }
      return { replyMessage: 'No se pudo interpretar el gasto.', success: false };
    } catch (err) {
      console.error('Error en simulación:', err);
      return {
        replyMessage: 'No se pudo registrar el gasto. No se guardaron datos de prueba.',
        success: false,
      };
    }
  };

  // Cálculos consolidados del mes actual
  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const currentMonthExpenses = expensesForMonth(expenses, currentMonthStr);
  const totalSpent = sumAmounts(currentMonthExpenses);
  const sharedTotal = sumAmounts(currentMonthExpenses.filter((e) => e.isShared));
  const personalTotal = sumAmounts(currentMonthExpenses.filter((e) => !e.isShared));

  const pendingBills = bills.filter((b) => b.status === 'pending' && b.dueDate.slice(0, 7) === currentMonthStr);
  const totalPendingBills = sumAmounts(pendingBills);

  return (
    <FinanceContext.Provider
      value={{
        isDemoMode: true,
        members,
        activeMemberId,
        setActiveMemberId,
        cards,
        bills,
        expenses,
        currentMonthExpenses,
        whatsappLogs,
        whatsappConfig,
        addExpense,
        deleteExpense,
        addBill,
        toggleBillPaid,
        deleteBill,
        addCard,
        deleteCard,
        addMember,
        updateMemberBudget,
        saveWhatsAppConfig,
        simulateWhatsAppMessage,
        refreshWhatsAppLogs,
        formatCurrency,
        currentMonthSummary: {
          totalSpent,
          sharedTotal,
          personalTotal,
          totalPendingBills,
          nextVencimientosCount: pendingBills.length,
        },
      }}
    >
      {children}
    </FinanceContext.Provider>
  );
};

export const useFinance = () => {
  const context = useContext(FinanceContext);
  if (!context) {
    throw new Error('useFinance debe ser utilizado dentro de un FinanceProvider');
  }
  return context;
};

// Demo opt-in: datos anteriores preservados, sin activar gastos ficticios en producción.
export const FinanceProvider:React.FC<{children:ReactNode}> = ({children}) =>
  import.meta.env.VITE_ENABLE_DEMO === 'true'
    ? <LegacyFinanceProvider>{children}</LegacyFinanceProvider>
    : <DatabaseFinanceProvider>{children}</DatabaseFinanceProvider>;
