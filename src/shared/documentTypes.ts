import type {FixedOccurrence,PaymentCode} from './apiTypes';
// Borradores de comprobantes: los comparten el servidor (que los arma) y la pantalla de revisión (que los muestra y corrige).
export type DocumentKind='purchase_receipt'|'pending_invoice'|'payment_receipt'|'card_statement'|'unknown';
export type DocumentState='received'|'processing'|'needs_review'|'confirmed'|'cancelled'|'failed';
export type StatementLineKind='purchase'|'refund'|'interest'|'fee'|'tax'|'adjustment'|'payment'|'other';
// Importes siempre como texto decimal exacto ("1234.56"): nunca coma flotante.
export interface MoneyLine {description:string;amount:string}
export interface DuplicateRef {expenseId:string;date:string;amount:string;currency:string;label:string;author:string|null}
// auto: ajuste (redondeo) al que el sistema le puso la categoría principal; si el usuario elige otra, deja de ser automático.
export interface DraftItem {id:number;description:string;amount:string;categoryId:string|null;excluded:boolean;adjustment?:boolean;auto?:boolean}
export interface DraftLine {
 id:number;date:string|null;merchant:string;amount:string;currency:string;kind:StatementLineKind;installment:{current:number;total:number}|null;
 categoryId:string|null;excluded:boolean;blockedReason:string|null;duplicates:DuplicateRef[];
 refundCandidates:DuplicateRef[];refundOf:string|null;acceptDuplicate:boolean;scope:'personal'|'household';
}
export interface ReceiptDraft {
 kind:'purchase_receipt'|'payment_receipt';scope:'personal'|'household';currency:string;date:string|null;merchant:string|null;description:string;
 total:string|null;items:DraftItem[];components:{discounts:MoneyLine[];taxes:MoneyLine[];surcharges:MoneyLine[];taxesIncluded:boolean;rounding?:string|null};
 paymentMethod:PaymentCode|null;cardId:string|null;duplicates:DuplicateRef[];linkExpenseId:string|null;noExpense:boolean;noExpenseReason:string|null;
 paymentReference:string|null;notes:string[];
 // La lectura quedó con una duda que el usuario debe ver (total o fecha dudosos): el bot no lo registra solo.
 doubt?:boolean;
 // Obligación fija pendiente que este comprobante parece saldar (solo se calcula para administradores). Al confirmar se registra UN gasto y se vincula.
 settle?:{occurrenceId:string;label:string;categoryId:string}|null;
}
export interface InvoiceDraft {
 kind:'pending_invoice';issuer:string|null;concept:string|null;period:string|null;amount:string|null;currency:string;issueDate:string|null;dueDate:string|null;reference:string|null;notes:string[];
}
export interface StatementDraft {
 kind:'card_statement';issuer:string|null;period:string|null;closingDate:string|null;dueDate:string|null;cardId:string|null;
 lines:DraftLine[];totals:{currency:string;statement:string|null;lines:string}[];notes:string[];
}
export type Draft=ReceiptDraft|InvoiceDraft|StatementDraft;
// Lo que la pantalla de comprobantes recibe del servidor. draft solo viene mientras el comprobante espera revisión.
export interface DocumentDto {
 id:string;shortCode:string;kind:DocumentKind|null;state:DocumentState;createdAt:string;expiresAt:string;errorCode:string|null;
 author:string|null;mine:boolean;draft:Draft|null;result:Record<string,unknown>|null;occurrences?:FixedOccurrence[];
}
