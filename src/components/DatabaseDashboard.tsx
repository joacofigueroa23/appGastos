import React,{useState} from 'react';
import {useFinance} from '../context/FinanceContext';
import {PAYMENT_LABELS} from '../shared/apiTypes';
import {todayDateOnly,sumAmounts} from '../utils/finance';
export function DatabaseDashboard({onOpenAddExpense}:{onOpenAddExpense:()=>void}) {
 const {expenses,apiExpenses=[],apiCards=[],formatCurrency,loading,error,refresh}=useFinance();
 const [month,setMonth]=useState(todayDateOnly().slice(0,7)),[currency,setCurrency]=useState('ARS');
 const selected=apiExpenses.filter(e=>e.date.slice(0,7)===month&&e.currency===currency);
 const cardExpenses=selected.filter(e=>e.paymentMethod==='credit_card'||e.paymentMethod==='debit_card');
 const cashExpenses=selected.filter(e=>e.paymentMethod==='cash');
 const aggregate=(key:'categoryName'|'paymentMethod'|'cardId')=>{
  const groups=new Map<string,{amount:number}[]>();
  (key==='cardId'?cardExpenses:selected).forEach(e=>{const name=e[key]||'Sin tarjeta especificada';const group=groups.get(name)||[];group.push({amount:Number(e.amount)});groups.set(name,group);});
  return [...groups].map(([name,values])=>({name,total:sumAmounts(values)})).sort((a,b)=>b.total-a.total);
 };
 return <div className="space-y-6">
  <div className="bg-white p-6 rounded-3xl border border-slate-200 flex flex-wrap justify-between gap-4">
   <h1 className="text-2xl font-bold">Control de Gastos del Hogar</h1><div className="flex gap-3">
    <label className="text-xs text-slate-500">Mes<input aria-label="Mes del dashboard" type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label>
    <select aria-label="Moneda del dashboard" value={currency} onChange={e=>setCurrency(e.target.value)}>
     {[...new Set(['ARS',...expenses.map(e=>e.currency)])].map(c=><option key={c}>{c}</option>)}
    </select>
    <button onClick={onOpenAddExpense} disabled={loading||!!error} className="bg-blue-600 text-white px-4 py-2 rounded-xl">Cargar Gasto</button>
   </div>
  </div>
  {loading&&<p role="status">Cargando gastos…</p>}
  {error&&<div role="alert" className="text-red-700">{error} <button onClick={()=>void refresh?.()}>Reintentar</button></div>}
  {!loading&&!error&&<>
   <div className="grid sm:grid-cols-2 gap-4">
    <div className="bg-white p-5 rounded-2xl border"><p>Total Gastado del Período ({currency})</p><strong className="text-2xl">{formatCurrency(sumAmounts(selected.map(e=>({amount:Number(e.amount)}))),currency)}</strong></div>
    <div className="bg-white p-5 rounded-2xl border"><p>Cantidad de gastos</p><strong className="text-2xl">{selected.length}</strong></div>
   </div>
   {(['categoryName','paymentMethod','cardId'] as const).map(key=><section key={key} aria-label={key==='categoryName'?'Gastos por Categoría':key==='paymentMethod'?'Gastos por Medio de Pago':'Gastos por Tarjeta'} className="bg-white p-6 rounded-2xl border space-y-3">
    <h2 className="font-bold">{key==='categoryName'?'Gastos por Categoría':key==='paymentMethod'?'Gastos por Medio de Pago':'Gastos por Tarjeta'}</h2>
    {aggregate(key).map(row=><div key={row.name} className="flex justify-between text-sm"><span>{key==='paymentMethod'?PAYMENT_LABELS[row.name as keyof typeof PAYMENT_LABELS]:key==='cardId'?(apiCards.find(c=>c.id===row.name)?.name||row.name):row.name}</span><strong>{formatCurrency(row.total,currency)}</strong></div>)}
    {!(key==='cardId'?cardExpenses:selected).length&&<p className="text-sm text-slate-500">{key==='cardId'?'Sin gastos con tarjeta para este período y moneda.':'Sin gastos para este período y moneda.'}</p>}
   </section>)}
   <section aria-label="Gastos en Efectivo" className="bg-white p-6 rounded-2xl border space-y-3">
    <h2 className="font-bold">Gastos en Efectivo</h2>
    {cashExpenses.length>0?<div className="flex justify-between text-sm"><span>Efectivo ({cashExpenses.length} {cashExpenses.length===1?'gasto':'gastos'})</span><strong>{formatCurrency(sumAmounts(cashExpenses.map(e=>({amount:Number(e.amount)}))),currency)}</strong></div>:<p className="text-sm text-slate-500">Sin gastos en efectivo para este período y moneda.</p>}
   </section>
  </>}
 </div>;
}
