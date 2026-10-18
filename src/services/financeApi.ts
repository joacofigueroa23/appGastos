import type { ApiCard, ApiCategory, ApiExpense, ApiMember, AuthMember, ExpenseWrite, CardWrite, MemberWrite, ExpenseFilters } from '../shared/apiTypes';
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
  createCard: (input:CardWrite) => request<{card:ApiCard}>('/api/cards','POST',input),
};
