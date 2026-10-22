import React,{useEffect,useState} from 'react';
import {financeApi} from '../services/financeApi';
import {useFinance} from '../context/FinanceContext';
import {expensesStamp} from '../utils/finance';
import type {ControlSummary as Summary} from '../shared/apiTypes';
// Dos controles independientes, siempre por separado (solo administradores): gastos fijos y presupuesto variable.
// Total gastado = fijos pagados + variables registrados. Lo pendiente y las deudas anteriores NO son gasto.
export function ControlSummary({month}:{month:string}){
 const {formatCurrency,apiExpenses}=useFinance();
 const [s,setS]=useState<Summary|null>(null),[error,setError]=useState<string|null>(null);
 useEffect(()=>{let live=true;financeApi.controlSummary(month).then(r=>{if(live){setS(r);setError(null);}}).catch(e=>{if(live)setError(e instanceof Error?e.message:'No se pudo cargar el resumen.');});return ()=>{live=false;};},[month,expensesStamp(apiExpenses)]);
 if(error)return <p role="alert" className="text-sm text-red-700">{error}</p>;
 if(!s)return null;
 const money=(v:string)=>formatCurrency(Number(v),'ARS'),box='bg-white p-4 sm:p-6 rounded-3xl space-y-3',cell=(label:string,value:string,extra='')=><div><p className="text-xs text-slate-500">{label}</p><strong className={'text-lg '+extra}>{value}</strong></div>;
 return <section aria-label="Control financiero del mes" className="grid lg:grid-cols-3 gap-4">
  <div className={box}><h2 className="text-sm font-bold">Gastos fijos</h2>
   <div className="grid grid-cols-2 gap-3">
    {cell('Pagados',money(s.fixed.paid.amount))}{cell('Pendientes ('+s.fixed.pending.count+')',money(s.fixed.pending.amount))}
    {cell('Vencidos ('+s.fixed.overdue.count+')',money(s.fixed.overdue.amount),Number(s.fixed.overdue.amount)>0?'text-red-700':'')}{cell('Deudas anteriores ('+s.fixed.previousDebts.count+')',money(s.fixed.previousDebts.amount),Number(s.fixed.previousDebts.amount)>0?'text-red-700':'')}
   </div>
   {s.fixed.paidLate.count>0&&<p className="text-xs text-slate-500">Incluye {money(s.fixed.paidLate.amount)} de pagos atrasados de meses anteriores, contados en el mes en que se pagaron.</p>}
  </div>
  <div className={box}><h2 className="text-sm font-bold">Presupuesto variable</h2>
   <div className="grid grid-cols-2 gap-3">
    {cell('Presupuesto',money(s.variable.budgeted))}{cell('Consumido ('+s.variable.percent.toLocaleString('es-AR')+'%)',money(s.variable.spent))}
    {cell('Disponible',money(s.variable.available),Number(s.variable.available)<0?'text-red-700':'')}{cell('Variables registrados',money(s.variable.registered))}
   </div>
   {Number(s.variable.unbudgetedSpent)>0&&<p className="text-xs text-slate-500">{money(s.variable.unbudgetedSpent)} de gasto variable sin presupuesto asignado.</p>}
  </div>
  <div className={box}><h2 className="text-sm font-bold">Total gastado</h2>
   <strong className="text-2xl block">{money(s.totalSpent)}</strong>
   <p className="text-xs text-slate-500">Fijos pagados + variables registrados. Los pagos de gastos fijos no descuentan de los presupuestos variables, y lo pendiente no cuenta como gasto.</p>
  </div>
 </section>;
}
