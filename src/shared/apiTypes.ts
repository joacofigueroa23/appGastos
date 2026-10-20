export const PAYMENT_CODES = ['cash','debit_card','credit_card','transfer','wallet','other'] as const;
export type PaymentCode = (typeof PAYMENT_CODES)[number];
export const PAYMENT_LABELS: Record<PaymentCode, import("../types").PaymentMethod> = {
  cash: 'Efectivo', debit_card: 'Tarjeta de Débito', credit_card: 'Tarjeta de Crédito',
  transfer: 'Transferencia', wallet: 'Billetera Virtual', other: 'Otro',
};
export interface ApiCategory { id: string; familyId: string; name: string; active: boolean; createdAt: string }
export const CARD_TYPES = ['credit_card','debit_card'] as const;
export type CardType = (typeof CARD_TYPES)[number];
export interface ApiCard extends ApiCategory { cardType: CardType | null }
// linked: el integrante tiene cuenta propia (acceso web). No expone el identificador de la cuenta.
export type Role = 'admin' | 'member';
export interface ApiMember extends ApiCategory { phoneNumber: string | null; linked: boolean; role: Role }
// scope: personal o gasto de la casa. null = sin clasificar (histórico), nunca se infiere.
export type ExpenseScope = 'personal' | 'household';
export interface ExpenseWrite {
  scope?: ExpenseScope | null;
  date: string; amount: string; currency: string; merchant: string | null;
  description: string; categoryId: string; paymentMethod: PaymentCode;
  cardId: string | null; reportedByMemberId: string | null;
}
export interface ApiExpense extends ExpenseWrite {
  id: string; familyId: string; categoryName: string; source: 'manual' | 'whatsapp';
  createdAt: string; updatedAt: string;
}

// Integrante con sesión: su cuenta, su WhatsApp vinculado y un código de vinculación vigente, si lo hay.
export interface AuthMember { id: string; name: string; email: string | null; phoneNumber: string | null; role: Role; pendingLink: { expiresAt: string } | null }
export interface CardWrite {name:string;active?:boolean;cardType?:CardType|null}
export interface MemberWrite {name:string;active?:boolean;phoneNumber:string|null}
export interface ExpenseFilters {
 month?:string;currency?:string;categoryId?:string;paymentMethod?:PaymentCode;
 cardId?:string;reportedByMemberId?:string;merchant?:string;scope?:ExpenseScope|'none';
}

export interface BudgetLine {categoryId:string;categoryName:string;amount:string;spent:string;available:string;percent:number;exceeded:boolean}
export interface BudgetReport {
 month:string;currency:string;budgets:BudgetLine[];
 // Categorías con gasto en el mes y sin presupuesto asignado: se informan aparte, nunca se ocultan.
 unbudgeted:{categoryId:string;categoryName:string;spent:string}[];
 // budgeted = suma de los presupuestos por categoría. spent y available se miden solo sobre categorías presupuestadas;
 // totalSpent es todo el gasto del mes (incluye lo no presupuestado).
 totals:{budgeted:string;spent:string;available:string;percent:number;unbudgetedSpent:string;totalSpent:string;exceededCount:number};
}

// Gastos fijos (solo administradores). status 'overdue' = sin pagar y vencida; se calcula, no se guarda.
export interface FixedExpense { id: string; name: string; categoryId: string; categoryName: string; expectedAmount: string; currency: string; frequency: 'monthly'; startDate: string; dueDay: number; endDate: string | null; installmentsTotal: number | null; active: boolean }
export interface FixedOccurrence { id: string; fixedExpenseId: string; name: string; categoryName: string; month: string; dueDate: string; expectedAmount: string; installmentNumber: number | null; installmentsTotal: number | null; expenseId: string | null; linkSource: 'auto' | 'manual' | null; paidAmount: string | null; paidDate: string | null; status: 'pending' | 'paid' | 'overdue' }
export interface UnlinkedPayment { id: string; date: string; amount: string; currency: string; description: string; categoryName: string; authorName: string | null }
