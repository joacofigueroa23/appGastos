import React,{useEffect,useState} from 'react';
import {financeApi} from '../services/financeApi';
import {useFinance} from '../context/FinanceContext';
import {expensesStamp} from '../utils/finance';
import type {FixedOccurrence} from '../shared/apiTypes';
// Obligaciones para el panel del administrador: lo pagado y pendiente del mes, y TODO lo vencido sin pagar (de cualquier mes).
export function FixedSummary({month}:{month:string}){
 const {formatCurrency,apiExpenses}=useFinance();
 const [list,setList]=useState<FixedOccurrence[]|null>(null),[late,setLate]=useState<FixedOccurrence[]>([]);
 const stamp=expensesStamp(apiExpenses);
 useEffect(()=>{
  let live=true;
  Promise.all([financeApi.occurrences(month),financeApi.overdueOccurrences()]).then(([o,l])=>{if(live){setList(o.occurrences);setLate(l.occurrences);}}).catch(()=>live&&setList(null));
  return ()=>{live=false;};
 },[month,stamp]);
 if(!list||(!list.length&&!late.length))return null;
 const money=(v:number|string)=>formatCurrency(Number(v),'ARS'),by=(s:string)=>list.filter(o=>o.status===s),total=(l:FixedOccurrence[])=>l.reduce((n,o)=>n+Number(o.expectedAmount),0);
 const next=[...late,...by('pending')].slice(0,4);
 return <section aria-label="Gastos fijos del mes" className="bg-white p-4 sm:p-6 rounded-3xl space-y-4">
  <h2 className="text-lg font-bold">Gastos fijos</h2>
  <div className="grid sm:grid-cols-3 gap-4">
   <div><p className="text-xs text-slate-500">Pagadas del mes ({by('paid').length})</p><strong className="text-xl">{money(total(by('paid')))}</strong></div>
   <div><p className="text-xs text-slate-500">Pendientes del mes ({by('pending').length})</p><strong className="text-xl">{money(total(by('pending')))}</strong></div>
   <div><p className="text-xs text-slate-500">Vencidas sin pagar, todos los meses ({late.length})</p><strong className={'text-xl '+(late.length?'text-red-700':'')}>{money(total(late))}</strong></div>
  </div>
  {next.length>0&&<div className="space-y-1"><p className="text-xs text-slate-500">Para atender</p>
   {next.map(o=><div key={o.id} className="flex justify-between gap-3 text-sm"><span className="truncate">{o.name} · {o.dueDate}{o.status==='overdue'?' (vencida)':''}</span><strong>{money(o.expectedAmount)}</strong></div>)}</div>}
 </section>;
}
