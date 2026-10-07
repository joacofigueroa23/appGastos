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

interface FinanceContextType {
  members: FamilyMember[];
  activeMemberId: string;
  setActiveMemberId: (id: string) => void;
  cards: CreditCard[];
  bills: BillDue[];
  expenses: Expense[];
  whatsappLogs: WhatsAppLog[];
  whatsappConfig: WhatsAppWebhookConfig;
  
  // Acciones de Gastos
  addExpense: (expense: Omit<Expense, 'id' | 'createdAt'>) => void;
  deleteExpense: (id: string) => void;
  
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

const FinanceContext = createContext<FinanceContextType | undefined>(undefined);

export const FinanceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
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
    verifyToken: 'gastos_familia_meta_2026',
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

  useEffect(() => {
    localStorage.setItem('gf_expenses', JSON.stringify(expenses));
  }, [expenses]);

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

  const formatCurrency = (amount: number, _currency = 'ARS') => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const addExpense = (newExpData: Omit<Expense, 'id' | 'createdAt'>) => {
    const newExpense: Expense = {
      ...newExpData,
      id: `exp-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      createdAt: new Date().toISOString(),
    };
    setExpenses((prev) => [newExpense, ...prev]);
  };

  const deleteExpense = (id: string) => {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
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
          paidDate: isPaid ? undefined : new Date().toISOString().split('T')[0],
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

        // Si se extrajo una tarjeta, vincular con la primera que coincida o una del miembro
        let matchedCard = cards.find((c) =>
          ext.cardName && c.name.toLowerCase().includes(ext.cardName.toLowerCase())
        );
        if (!matchedCard && ext.paymentMethod === 'Tarjeta de Crédito') {
          matchedCard = cards.find((c) => c.ownerMemberId === member.id) || cards[0];
        }

        // Agregar gasto a la lista oficial de la app
        addExpense({
          description: ext.description || message.slice(0, 40),
          amount: ext.amount || 1000,
          currency: ext.currency || 'ARS',
          category: ext.category || 'Otros',
          date: new Date().toISOString().split('T')[0],
          paymentMethod: ext.paymentMethod || 'Tarjeta de Crédito',
          cardId: matchedCard?.id,
          paidByMemberId: member.id,
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
      // Fallback local en caso de falla de red
      addExpense({
        description: message.slice(0, 40) || 'Gasto registrado',
        amount: 5000,
        currency: 'ARS',
        category: 'Alimentación & Salidas',
        date: new Date().toISOString().split('T')[0],
        paymentMethod: 'Tarjeta de Débito',
        paidByMemberId: member.id,
        isShared: true,
        installmentTotal: 1,
        installmentCurrent: 1,
        source: 'whatsapp',
        whatsappMessage: message,
      });
      return {
        replyMessage: `✅ Registrado gasto de prueba para ${member.name}.`,
        success: true,
      };
    }
  };

  // Cálculos consolidados del mes actual
  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const currentMonthExpenses = expenses.filter((e) => e.date.startsWith(currentMonthStr));
  const totalSpent = currentMonthExpenses.reduce((acc, curr) => acc + curr.amount, 0);
  const sharedTotal = currentMonthExpenses
    .filter((e) => e.isShared)
    .reduce((acc, curr) => acc + curr.amount, 0);
  const personalTotal = currentMonthExpenses
    .filter((e) => !e.isShared)
    .reduce((acc, curr) => acc + curr.amount, 0);

  const pendingBills = bills.filter((b) => b.status === 'pending');
  const totalPendingBills = pendingBills.reduce((acc, b) => acc + b.amount, 0);

  return (
    <FinanceContext.Provider
      value={{
        members,
        activeMemberId,
        setActiveMemberId,
        cards,
        bills,
        expenses,
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
