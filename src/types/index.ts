import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from '../data/financeCatalog';

export type MemberRole = 'admin' | 'member' | 'teen';

export interface FamilyMember {
  id: string;
  name: string;
  avatar: string;
  role: MemberRole;
  color: string;
  phoneNumber?: string;
  monthlyBudget: number;
}

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type PaymentMethod = (typeof PAYMENT_METHODS)[number] | 'Otro';

export interface Expense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  category: string;
  categoryId?: string;
  merchant?: string;
  date: string; // YYYY-MM-DD
  paymentMethod: PaymentMethod;
  cardId?: string;
  paidByMemberId: string; // Compatibilidad con vistas anteriores.
  reportedByMemberId?: string; // Quién cargó o informó el gasto.
  isShared: boolean; // true = gasto común del hogar, false = personal
  installmentTotal: number; // 1 = contado / 1 pago
  installmentCurrent: number; // 1, 2, ...
  notes?: string;
  source: 'whatsapp' | 'manual' | 'receipt';
  scope?: 'personal' | 'household' | null; // solo modo real: null = sin clasificar
  whatsappMessage?: string;
  createdAt: string;
}

export interface CardIdentity {
  id: string;
  name: string;
  active: boolean;
}
// Los campos bancarios anteriores permanecen para calendario y vistas existentes.
export interface CreditCard {
  id: string;
  name: string;
  active?: boolean; // Los registros antiguos sin el campo se consideran activos.
  bank: string;
  lastDigits: string;
  closingDay: number; // Día del mes (1-31)
  dueDay: number; // Día del mes (1-31)
  creditLimit: number;
  ownerMemberId: string;
  color: string;
}

export type BillStatus = 'pending' | 'paid' | 'overdue';

export interface BillDue {
  id: string;
  title: string;
  serviceCategory: string;
  amount: number;
  dueDate: string; // YYYY-MM-DD
  isRecurring: boolean;
  autoDebit: boolean;
  status: BillStatus;
  paidDate?: string;
  paidByMemberId?: string;
  receiptNumber?: string;
}

export interface WhatsAppWebhookConfig {
  verifyToken: string;
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
}

export interface WhatsAppLog {
  id: string;
  timestamp: string;
  fromNumber: string;
  memberName?: string;
  rawMessage: string;
  extractedExpense?: Partial<Expense>;
  status: 'success' | 'clarification_needed' | 'error';
  replySent: string;
}
