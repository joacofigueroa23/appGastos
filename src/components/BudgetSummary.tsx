import React,{useEffect,useState} from 'react';
import {financeApi} from '../services/financeApi';
import {useFinance} from '../context/FinanceContext';
import {expensesStamp} from '../utils/finance';
import type {BudgetReport} from '../shared/apiTypes';
// Resumen del presupuesto del mes en el panel del administrador. Los importes llegan del servidor ya calculados.
export function BudgetSummary({month}:{month:string}){
 const {formatCurrency,apiExpenses}=useFinance();
 const [report,setReport]=useState<BudgetReport|null>(null),[failed,setFailed]=useState(false);
 // Se vuelve a pedir cuando cambian los gastos, para que el consumo no quede desactualizado.
 useEffect(()=>{
  let live=true;setFailed(false);
  financeApi.budgets(month).then(r=>live&&setReport(r)).catch(()=>live&&setFailed(true));
  return ()=>{live=false;};
 },[month,expensesStamp(apiExpenses)]);
 if(failed)return null;
 if(!report)return null;
 const money=(v:string)=>formatCurrency(Number(v),report.currency),t=report.totals;
 if(!report.budgets.length)return <section aria-label="Presupuesto del mes" className="bg-white p-4 sm:p-6 rounded-3xl"><h2 className="text-lg font-bold">Presupuesto del mes</h2><p className="text-sm text-slate-500 mt-1">Todavía no cargaste presupuestos para este mes. Podés hacerlo en Presupuestos.</p></section>;
 const exceeded=report.budgets.filter(b=>b.exceeded);
 return <section aria-label="Presupuesto del mes" className="bg-white p-4 sm:p-6 rounded-3xl space-y-4">
  <h2 className="text-lg font-bold">Presupuesto del mes</h2>
  <div className="grid sm:grid-cols-3 gap-4">
   <div><p className="text-xs text-slate-500">Presupuesto total</p><strong className="text-xl">{money(t.budgeted)}</strong></div>
   <div><p className="text-xs text-slate-500">Gastado</p><strong className="text-xl">{money(t.spent)}</strong></div>
   <div><p className="text-xs text-slate-500">Disponible</p><strong className={'text-xl '+(Number(t.available)<0?'text-red-700':'')}>{money(t.available)}</strong></div>
  </div>
  <div className="h-2 rounded-full bg-slate-100"><div className={'h-full rounded-full '+(t.percent>100?'bg-red-600':'bg-accent')} style={{width:Math.min(t.percent,100)+'%'}}/></div>
  <p className="text-xs text-slate-500">{t.percent.toLocaleString('es-AR')}% utilizado{Number(t.unbudgetedSpent)>0?' · '+money(t.unbudgetedSpent)+' en categorías sin presupuesto':''}</p>
  {exceeded.length>0&&<p className="text-sm text-red-700">Superaron el límite: {exceeded.map(b=>b.categoryName).join(', ')}.</p>}
 </section>;
}
