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
export interface ApiMember extends ApiCategory { phoneNumber: string | null }
export interface ExpenseWrite {
  date: string; amount: string; currency: string; merchant: string | null;
  description: string; categoryId: string; paymentMethod: PaymentCode;
  cardId: string | null; reportedByMemberId: string | null;
}
export interface ApiExpense extends ExpenseWrite {
  id: string; familyId: string; categoryName: string; source: 'manual' | 'whatsapp';
  createdAt: string; updatedAt: string;
}

export interface CardWrite {name:string;active?:boolean;cardType?:CardType|null}
export interface MemberWrite {name:string;active?:boolean;phoneNumber:string|null}
export interface ExpenseFilters {
 month?:string;currency?:string;categoryId?:string;paymentMethod?:PaymentCode;
 cardId?:string;reportedByMemberId?:string;merchant?:string;
}
