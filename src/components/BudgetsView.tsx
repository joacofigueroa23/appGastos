import React,{useCallback,useEffect,useState} from 'react';
import {financeApi} from '../services/financeApi';
import {useFinance} from '../context/FinanceContext';
import {expensesStamp,todayDateOnly} from '../utils/finance';
import type {BudgetReport} from '../shared/apiTypes';
const shift=(month:string,delta:number)=>{const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7);};
// Presupuestos mensuales por categoría (solo administradores; el servidor lo exige igual).
export function BudgetsView(){
 const {categories=[],formatCurrency,apiExpenses}=useFinance();
 const [month,setMonth]=useState(todayDateOnly().slice(0,7)),[report,setReport]=useState<BudgetReport|null>(null);
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
 const load=useCallback(async()=>{
  try{const r=await financeApi.budgets(month);setReport(r);setDrafts(Object.fromEntries(r.budgets.map(b=>[b.categoryId,b.amount])));setError(null);}
  catch(e){setError(e instanceof Error?e.message:'No se pudieron cargar los presupuestos.');}
 },[month]);
 useEffect(()=>{void load();},[load,expensesStamp(apiExpenses)]);
 async function run(action:()=>Promise<unknown>,ok:string){
  if(busy)return;setBusy(true);setError(null);setMessage(null);
  try{await action();await load();setMessage(ok);}catch(e){setError(e instanceof Error?e.message:'No se pudo guardar.');}finally{setBusy(false);}
 }
 const money=(v:string)=>formatCurrency(Number(v),'ARS'),t=report?.totals;
 const input='h-9 w-32 rounded-lg border border-slate-200 bg-white px-2 text-sm text-right';
 return <div className="space-y-6">
  <div className="flex flex-wrap items-end justify-between gap-4">
   <div><h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Presupuestos</h1><p className="text-sm text-slate-500 mt-1">Límite mensual por categoría. Cada mes es independiente y se mide con todos los gastos de la categoría.</p></div>
   <div className="flex flex-wrap items-end gap-3">
    <label className="text-xs text-slate-500 flex flex-col gap-1">Mes<input aria-label="Mes del presupuesto" type="month" value={month} onChange={e=>e.target.value&&setMonth(e.target.value)} className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm"/></label>
    <button disabled={busy} onClick={()=>void run(async()=>{const r=await financeApi.copyBudgets(shift(month,-1),month);setMessage(null);if(!r.copied)throw new Error('No había presupuestos para copiar del mes anterior (o ya estaban cargados).');},'Presupuestos copiados del mes anterior.')} className="h-10 px-4 rounded-xl bg-slate-100 text-sm font-semibold disabled:opacity-60">Copiar del mes anterior</button>
   </div>
  </div>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
  {message&&<p role="status" className="text-sm text-green-700">{message}</p>}
  {t&&<section aria-label="Totales del presupuesto" className="bg-white p-4 sm:p-6 rounded-3xl grid sm:grid-cols-4 gap-4">
   <div><p className="text-xs text-slate-500">Presupuesto total</p><strong className="text-xl">{money(t.budgeted)}</strong></div>
   <div><p className="text-xs text-slate-500">Gastado</p><strong className="text-xl">{money(t.spent)}</strong></div>
   <div><p className="text-xs text-slate-500">Disponible</p><strong className={'text-xl '+(Number(t.available)<0?'text-red-700':'')}>{money(t.available)}</strong></div>
   <div><p className="text-xs text-slate-500">Sin presupuesto asignado</p><strong className="text-xl">{money(t.unbudgetedSpent)}</strong></div>
  </section>}
  <section aria-label="Presupuesto por categoría" className="bg-white p-4 sm:p-6 rounded-3xl space-y-3">
   {categories.filter(c=>c.active||report?.budgets.some(b=>b.categoryId===c.id)).map(c=>{
    const b=report?.budgets.find(x=>x.categoryId===c.id),draft=drafts[c.id]??'';
    return <div key={c.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_8rem_8rem_5rem] items-center gap-3 text-sm">
     <span className="font-medium truncate">{c.name}{b?.exceeded&&<span className="ml-2 text-xs text-red-700">Excedido</span>}</span>
     <span className="flex items-center gap-2">
      <input aria-label={'Presupuesto de '+c.name} inputMode="decimal" placeholder="Sin límite" value={draft} onChange={e=>setDrafts(p=>({...p,[c.id]:e.target.value}))} className={input}/>
      <button disabled={busy||draft===(b?.amount??'')} className="h-9 px-3 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-40"
       onClick={()=>void run(()=>draft.trim()?financeApi.setBudget(month,c.id,draft.trim().replace(',','.')):financeApi.removeBudget(month,c.id),'Presupuesto guardado.')}>Guardar</button>
     </span>
     <span className="hidden sm:block text-right text-slate-600">{b?money(b.spent):''}</span>
     <span className={'hidden sm:block text-right '+(b&&Number(b.available)<0?'text-red-700':'text-slate-600')}>{b?money(b.available):''}</span>
     <span className="hidden sm:block text-right text-slate-500">{b?b.percent.toLocaleString('es-AR')+'%':''}</span>
    </div>;
   })}
   <p className="text-xs text-slate-500">Columnas: presupuesto · gastado · disponible · porcentaje utilizado. Dejá el campo vacío y guardá para quitar el límite.</p>
  </section>
 </div>;
}
