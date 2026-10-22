import type {DocumentKind,MoneyLine,StatementLineKind} from '../../shared/documentTypes';
import type {PaymentCode} from '../../shared/apiTypes';
export * from '../../shared/documentTypes';
export interface ExtractedItem {description:string;amount:string|null;category:string|null}
export interface ExtractedLine {date:string|null;merchant:string;amount:string|null;currency:string|null;kind:StatementLineKind;installmentCurrent:number|null;installmentTotal:number|null;category:string|null}
// Lo que el modelo leyó, ya validado. Es dato no confiable hasta que el usuario lo confirma.
export interface Extraction {
 documentType:DocumentKind;merchant:string|null;documentDate:string|null;dueDate:string|null;currency:string|null;totalAmount:string|null;
 taxesIncluded:boolean|null;items:ExtractedItem[];discounts:MoneyLine[];taxes:MoneyLine[];surcharges:MoneyLine[];
 paymentStatus:'paid'|'unpaid'|'unknown';paymentMethod:PaymentCode|null;paymentReference:string|null;isCardPayment:boolean|null;isOwnTransfer:boolean|null;
 statementPeriod:string|null;closingDate:string|null;statementTotals:{currency:string;total:string}[];lines:ExtractedLine[];
 // Lista escrita (a mano o impresa) de presupuestos mensuales por categoría o de gastos fijos: no es un comprobante, la usa el administrador para configurar.
 configList:{kind:'budget'|'fixed'|null;items:{name:string;amount:string|null;dueDay:number|null;category:string|null}[]};
 invoiceReference:string|null;concept:string|null;category:string|null;warnings:string[];missingFields:string[];
}
export interface ModelUsage {model:string;promptTokens:number|null;outputTokens:number|null;totalTokens:number|null;estimatedCostUsd:number|null;ms:number}
