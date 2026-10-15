import type { ApiCard, ApiCategory, ApiExpense, ApiMember, ExpenseWrite, CardWrite, MemberWrite, ExpenseFilters } from '../shared/apiTypes';
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path,{ method, headers: { 'Content-Type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'No se pudo completar la operación.');
  }
  if(res.status===204)return undefined as T;
  if(!res.headers.get('content-type')?.includes('application/json'))throw new Error('La API no respondió JSON. Reinicia Express desde la carpeta del proyecto con npm run dev.');
  return res.json();
}
export const financeApi = {
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
