import type { DocumentDto } from '../shared/documentTypes';
import type { ControlSummary, FixedExpense, FixedOccurrence, UnlinkedPayment, BudgetReport, ApiCard, ApiCategory, ApiExpense, ApiMember, AuthMember, Role, ExpenseWrite, CardWrite, MemberWrite, ExpenseFilters } from '../shared/apiTypes';
export class ApiRequestError extends Error { constructor(public status: number, message: string) { super(message); } }
// Con sesión individual (Supabase) cada pedido lleva el token; sin ella el navegador usa Basic Auth por su cuenta.
let tokenProvider: (() => Promise<string | null>) | null = null, onUnauthorized: (() => void) | null = null;
export function configureSession(provider: () => Promise<string | null>, unauthorized: () => void) { tokenProvider = provider; onUnauthorized = unauthorized; }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = tokenProvider ? await tokenProvider() : null;
  const res = await fetch(path,{ method, headers: { 'Content-Type':'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && tokenProvider) onUnauthorized?.();
    throw new ApiRequestError(res.status, data.error || 'No se pudo completar la operación.');
  }
  if(res.status===204)return undefined as T;
  if(!res.headers.get('content-type')?.includes('application/json'))throw new Error('La API no respondió JSON. Reinicia Express desde la carpeta del proyecto con npm run dev.');
  return res.json();
}
export const financeApi = {
  budgets: (month:string) => request<BudgetReport>('/api/budgets?month='+month),
  setBudget: (month:string,categoryId:string,amount:string) => request<void>('/api/budgets/'+month+'/'+categoryId,'PUT',{amount}),
  removeBudget: (month:string,categoryId:string) => request<void>('/api/budgets/'+month+'/'+categoryId,'DELETE'),
  setBudgetBase: (categoryId:string,amount:string,from?:string) => request<void>('/api/budgets/base/'+categoryId,'PUT',{amount,...(from?{from}:{})}),
  endBudgetBase: (categoryId:string,from?:string) => request<void>('/api/budgets/base/'+categoryId+(from?'?from='+from:''),'DELETE'),
  controlSummary: (month:string) => request<ControlSummary>('/api/control/summary?month='+month),
  createCategory: (input:{name:string;parentId?:string|null}) => request<{category:ApiCategory}>('/api/categories','POST',input),
  updateCategory: (id:string,input:{name?:string;parentId?:string|null;active?:boolean}) => request<{category:ApiCategory}>('/api/categories/'+id,'PATCH',input),
  copyBudgets: (from:string,to:string) => request<{copied:number}>('/api/budgets/copy','POST',{from,to}),
  fixedExpenses: () => request<{fixedExpenses:FixedExpense[]}>('/api/fixed-expenses'),
  createFixedExpense: (input:Record<string,unknown>) => request<{fixedExpense:FixedExpense}>('/api/fixed-expenses','POST',input),
  updateFixedExpense: (id:string,input:Record<string,unknown>) => request<{fixedExpense:FixedExpense}>('/api/fixed-expenses/'+id,'PATCH',input),
  overdueOccurrences: () => request<{occurrences:FixedOccurrence[]}>('/api/fixed-expenses/overdue'),
  payOccurrence: (id:string,input:{paymentMethod:string;amount?:string;date?:string}) => request<{expense:ApiExpense}>('/api/fixed-expenses/occurrences/'+id+'/pay','POST',input),
  occurrences: (month:string) => request<{occurrences:FixedOccurrence[]}>('/api/fixed-expenses/occurrences?month='+month),
  unlinkedPayments: (month:string) => request<{expenses:UnlinkedPayment[]}>('/api/fixed-expenses/unlinked?month='+month),
  linkPayment: (occurrenceId:string,expenseId:string) => request<void>('/api/fixed-expenses/occurrences/'+occurrenceId+'/link','POST',{expenseId}),
  unlinkPayment: (occurrenceId:string) => request<void>('/api/fixed-expenses/occurrences/'+occurrenceId+'/link','DELETE'),
  documents: () => request<{documents:DocumentDto[]}>('/api/documents'),
  document: (id:string) => request<{document:DocumentDto}>('/api/documents/'+id),
  editDocument: (id:string,body:{edits?:unknown[];kind?:string}) => request<{document:DocumentDto}>('/api/documents/'+id,'PATCH',body),
  uploadDocument: (filename:string,contentBase64:string) => request<{document:DocumentDto}>('/api/documents/upload','POST',{filename,contentBase64}),
  confirmDocument: (id:string,input:{occurrenceId?:string;newFixedCategoryId?:string}={}) => request<{message:string;document:DocumentDto}>('/api/documents/'+id+'/confirm','POST',input),
  cancelDocument: (id:string) => request<{message:string;document:DocumentDto}>('/api/documents/'+id+'/cancel','POST',{}),
  me: () => request<{member:AuthMember}>('/api/auth/me'),
  createLinkCode: () => request<{code:string;expiresAt:string}>('/api/auth/whatsapp-link','POST'),
  unlinkWhatsApp: () => request<void>('/api/auth/whatsapp-link','DELETE'),
  expenses: (filters:ExpenseFilters={}) => request<{expenses:ApiExpense[]}>('/api/expenses'+(Object.keys(filters).length?'?'+new URLSearchParams(filters as Record<string,string>):'')),
  categories: () => request<{categories:ApiCategory[]}>('/api/categories'),
  cards: () => request<{cards:ApiCard[]}>('/api/cards'),
  members: () => request<{members:ApiMember[]}>('/api/family-members'),
  create: (input:ExpenseWrite) => request<{expense:ApiExpense}>('/api/expenses','POST',input),
  update: (id:string,input:Partial<ExpenseWrite>) => request<{expense:ApiExpense}>('/api/expenses/'+id,'PATCH',input),
  remove: (id:string) => request<void>('/api/expenses/'+id,'DELETE'),
  updateCard: (id:string,input:Partial<CardWrite>) => request<{card:ApiCard}>('/api/cards/'+id,'PATCH',input),
  createMember: (input:MemberWrite) => request<{member:ApiMember}>('/api/family-members','POST',input),
  updateMember: (id:string,input:Partial<MemberWrite>) => request<{member:ApiMember}>('/api/family-members/'+id,'PATCH',input),
  setRole: (id:string,role:Role) => request<{member:{id:string;name:string;role:Role}}>('/api/family-members/'+id+'/role','PATCH',{role}),
  createCard: (input:CardWrite) => request<{card:ApiCard}>('/api/cards','POST',input),
};
