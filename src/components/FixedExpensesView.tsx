import React,{useCallback,useEffect,useState} from 'react';
import {financeApi} from '../services/financeApi';
import {useFinance} from '../context/FinanceContext';
import {expensesStamp,todayDateOnly} from '../utils/finance';
import {PAYMENT_CODES,PAYMENT_LABELS,type FixedExpense,type FixedOccurrence,type PaymentCode,type UnlinkedPayment} from '../shared/apiTypes';
const STATUS={paid:['Pagada','bg-green-100 text-green-800'],pending:['Pendiente','bg-slate-100 text-slate-700'],overdue:['Vencida','bg-red-100 text-red-800']} as const;
interface Paying {id:string;amount:string;date:string;method:PaymentCode}
// Gastos fijos y vencimientos (solo administradores; el servidor lo exige igual). Una obligación prevista no es un gasto:
// queda "pagada" cuando se registra el pago (se crea el gasto real) o se vincula uno ya cargado. Lo que vence y no se paga
// sigue a la vista como "Vencida", de cualquier mes, hasta que se paga.
export function FixedExpensesView(){
 const {categories=[],formatCurrency,apiExpenses,refresh}=useFinance();
 const [month,setMonth]=useState(todayDateOnly().slice(0,7));
 const [items,setItems]=useState<FixedExpense[]>([]),[occurrences,setOccurrences]=useState<FixedOccurrence[]>([]),[unlinked,setUnlinked]=useState<UnlinkedPayment[]>([]),[late,setLate]=useState<FixedOccurrence[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[paying,setPaying]=useState<Paying|null>(null);
 const [form,setForm]=useState({name:'',categoryId:'',expectedAmount:'',dueDay:'10',startDate:todayDateOnly().slice(0,8)+'01',endDate:'',installmentsTotal:''});
 const [amounts,setAmounts]=useState<Record<string,string>>({}),[targets,setTargets]=useState<Record<string,string>>({});
 const stamp=expensesStamp(apiExpenses);
 const load=useCallback(async()=>{
  try{
   const [f,o,u,l]=await Promise.all([financeApi.fixedExpenses(),financeApi.occurrences(month),financeApi.unlinkedPayments(month),financeApi.overdueOccurrences()]);
   setItems(f.fixedExpenses);setOccurrences(o.occurrences);setUnlinked(u.expenses);setLate(l.occurrences);setAmounts(Object.fromEntries(f.fixedExpenses.map(x=>[x.id,x.expectedAmount])));setError(null);
  }catch(e){setError(e instanceof Error?e.message:'No se pudieron cargar los gastos fijos.');}
 },[month]);
 useEffect(()=>{void load();},[load,stamp]);
 async function run(action:()=>Promise<unknown>,ok:string){
  if(busy)return;setBusy(true);setError(null);setMessage(null);
  try{await action();await load();setMessage(ok);}catch(e){setError(e instanceof Error?e.message:'No se pudo completar la operación.');}finally{setBusy(false);}
 }
 const money=(v:string)=>formatCurrency(Number(v),'ARS');
 const input='h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm',card='bg-white p-4 sm:p-6 rounded-3xl space-y-4';
 const open=occurrences.filter(o=>o.status!=='paid');
 const sum=(status:string)=>occurrences.filter(o=>o.status===status).reduce((n,o)=>n+Number(o.expectedAmount),0);
 const startPaying=(o:FixedOccurrence)=>setPaying({id:o.id,amount:o.expectedAmount,date:todayDateOnly(),method:'cash'});
 // Una fila de obligación; las sin pagar ofrecen "Marcar como pagada" y abren el formulario del pago debajo.
 const row=(o:FixedOccurrence,showMonth:boolean)=><div key={o.id} className="space-y-2">
  <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
   <div className="min-w-0"><p className="font-medium truncate">{o.name}{o.installmentsTotal?` · cuota ${o.installmentNumber}/${o.installmentsTotal}`:''}</p>
    <p className="text-xs text-slate-500">Vence el {o.dueDate}{showMonth?'':` · ${o.categoryName}`}{o.paidDate?` · pagada el ${o.paidDate}${o.paidAmount&&o.paidAmount!==o.expectedAmount?' por '+money(o.paidAmount):''}`:''}</p></div>
   <div className="flex items-center gap-3"><strong>{money(o.expectedAmount)}</strong>
    <span className={'text-xs px-2 py-1 rounded-lg '+STATUS[o.status][1]}>{STATUS[o.status][0]}</span>
    {o.status!=='paid'&&<button disabled={busy} className="h-8 px-3 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-40" onClick={()=>startPaying(o)}>Marcar como pagada</button>}
    {o.status==='paid'&&<button disabled={busy} className="text-xs text-blue-700" onClick={()=>void run(()=>financeApi.unlinkPayment(o.id),'Pago desvinculado. El gasto sigue en el Historial.')}>Desvincular</button>}</div>
  </div>
  {paying?.id===o.id&&<form className="flex flex-wrap items-end gap-3 rounded-2xl bg-slate-50 p-3" onSubmit={e=>{e.preventDefault();void run(async()=>{await financeApi.payOccurrence(o.id,{paymentMethod:paying.method,amount:paying.amount.trim().replace(',','.'),date:paying.date});setPaying(null);await refresh?.();},'Pago registrado. Se creó el gasto en el Historial.');}}>
   <label className="text-xs text-slate-500">Importe pagado<input aria-label="Importe pagado" inputMode="decimal" required value={paying.amount} onChange={e=>setPaying({...paying,amount:e.target.value})} className={input+' w-32 mt-1 block'}/></label>
   <label className="text-xs text-slate-500">Fecha del pago<input aria-label="Fecha del pago" type="date" required value={paying.date} onChange={e=>setPaying({...paying,date:e.target.value})} className={input+' mt-1 block'}/></label>
   <label className="text-xs text-slate-500">Medio de pago<select aria-label="Medio de pago del pago" value={paying.method} onChange={e=>setPaying({...paying,method:e.target.value as PaymentCode})} className={input+' mt-1 block'}>{PAYMENT_CODES.map(c=><option key={c} value={c}>{PAYMENT_LABELS[c]}</option>)}</select></label>
   <button type="submit" disabled={busy} className="h-10 px-4 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-60">Confirmar pago</button>
   <button type="button" className="h-10 px-3 text-sm" onClick={()=>setPaying(null)}>Cancelar</button>
  </form>}
 </div>;
 return <div className="space-y-6">
  <div className="flex flex-wrap items-end justify-between gap-4">
   <div><h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Gastos fijos</h1><p className="text-sm text-slate-500 mt-1">Obligaciones que se repiten cada mes. Si no se pagan, quedan vencidas hasta que las marques como pagadas.</p></div>
   <label className="text-xs text-slate-500 flex flex-col gap-1">Mes<input aria-label="Mes de los gastos fijos" type="month" value={month} onChange={e=>e.target.value&&setMonth(e.target.value)} className={input}/></label>
  </div>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
  {message&&<p role="status" className="text-sm text-green-700">{message}</p>}
  {late.length>0&&<section aria-label="Vencidas sin pagar" className={card+' border border-red-200'}>
   <h2 className="text-lg font-bold text-red-800">Vencidas sin pagar ({late.length})</h2>
   <p className="text-xs text-slate-500">De cualquier mes. Siguen acá hasta que se pagan.</p>
   {late.map(o=>row(o,true))}
  </section>}
  <section aria-label="Resumen de obligaciones" className={card+' grid sm:grid-cols-3 gap-4 !space-y-0'}>
   {(['paid','pending','overdue'] as const).map(s=><div key={s}><p className="text-xs text-slate-500">{STATUS[s][0]}s del mes ({occurrences.filter(o=>o.status===s).length})</p><strong className="text-xl">{money(String(sum(s)))}</strong></div>)}
  </section>
  <section aria-label="Obligaciones del mes" className={card}>
   <h2 className="text-lg font-bold">Obligaciones del mes</h2>
   {occurrences.map(o=>row(o,false))}
   {!occurrences.length&&<p className="text-sm text-slate-500">No hay obligaciones para este mes.</p>}
  </section>
  <section aria-label="Pagos sin vincular" className={card}>
   <h2 className="text-lg font-bold">Pagos de la casa sin vincular</h2>
   <p className="text-xs text-slate-500">Gastos de la casa del mes que no coinciden con una única obligación. Elegí a cuál corresponden.</p>
   {unlinked.map(e=><div key={e.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
    <div className="min-w-0"><p className="font-medium truncate">{e.description}</p><p className="text-xs text-slate-500">{e.date} · {e.categoryName} · {e.authorName||'Sin autor identificado'}</p></div>
    <div className="flex items-center gap-2"><strong>{money(e.amount)}</strong>
     <select aria-label={'Obligación para '+e.description} className="h-9 rounded-lg border border-slate-200 px-2 text-xs" value={targets[e.id]||''} onChange={ev=>setTargets(p=>({...p,[e.id]:ev.target.value}))}>
      <option value="">Elegir obligación</option>{open.map(o=><option key={o.id} value={o.id}>{o.name} ({money(o.expectedAmount)})</option>)}
     </select>
     <button disabled={busy||!targets[e.id]} className="h-9 px-3 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-40" onClick={()=>void run(()=>financeApi.linkPayment(targets[e.id],e.id),'Pago vinculado.')}>Vincular</button></div>
   </div>)}
   {!unlinked.length&&<p className="text-sm text-slate-500">No hay pagos pendientes de vincular.</p>}
  </section>
  <section aria-label="Definición de gastos fijos" className={card}>
   <h2 className="text-lg font-bold">Gastos fijos definidos</h2>
   {items.map(f=><div key={f.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
    <div className="min-w-0"><p className="font-medium truncate">{f.name}{f.active?'':' (inactivo)'}</p><p className="text-xs text-slate-500">{f.categoryName} · día {f.dueDay} · desde {f.startDate}{f.endDate?' hasta '+f.endDate:''}{f.installmentsTotal?' · '+f.installmentsTotal+' cuotas':''}</p></div>
    <div className="flex items-center gap-2">
     <input aria-label={'Importe de '+f.name} inputMode="decimal" value={amounts[f.id]??''} onChange={e=>setAmounts(p=>({...p,[f.id]:e.target.value}))} className="h-9 w-28 rounded-lg border border-slate-200 px-2 text-sm text-right"/>
     <button disabled={busy||amounts[f.id]===f.expectedAmount} className="h-9 px-3 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-40" onClick={()=>void run(()=>financeApi.updateFixedExpense(f.id,{expectedAmount:(amounts[f.id]||'').trim().replace(',','.')}),'Importe actualizado para este mes en adelante.')}>Guardar</button>
     <button disabled={busy} className="text-xs text-blue-700" onClick={()=>void run(()=>financeApi.updateFixedExpense(f.id,{active:!f.active}),f.active?'Gasto fijo desactivado.':'Gasto fijo activado.')}>{f.active?'Desactivar':'Activar'}</button></div>
   </div>)}
   <form className="grid sm:grid-cols-3 gap-3 pt-2" onSubmit={e=>{e.preventDefault();void run(async()=>{
    await financeApi.createFixedExpense({name:form.name,categoryId:form.categoryId,expectedAmount:form.expectedAmount.trim().replace(',','.'),dueDay:Number(form.dueDay),startDate:form.startDate,
     ...(form.endDate?{endDate:form.endDate}:{}),...(form.installmentsTotal?{installmentsTotal:Number(form.installmentsTotal)}:{})});
    setForm(p=>({...p,name:'',expectedAmount:'',endDate:'',installmentsTotal:''}));},'Gasto fijo creado.');}}>
    <input aria-label="Nombre del gasto fijo" placeholder="Nombre (ej. Colegio)" required maxLength={120} value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} className={input}/>
    <select aria-label="Categoría del gasto fijo" required value={form.categoryId} onChange={e=>setForm(p=>({...p,categoryId:e.target.value}))} className={input}><option value="">Categoría</option>{categories.filter(c=>c.active).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
    <input aria-label="Importe previsto" placeholder="Importe previsto" required inputMode="decimal" value={form.expectedAmount} onChange={e=>setForm(p=>({...p,expectedAmount:e.target.value}))} className={input}/>
    <label className="text-xs text-slate-500">Día de vencimiento<input aria-label="Día de vencimiento" type="number" min={1} max={31} required value={form.dueDay} onChange={e=>setForm(p=>({...p,dueDay:e.target.value}))} className={input+' w-full mt-1'}/></label>
    <label className="text-xs text-slate-500">Desde<input aria-label="Fecha de inicio" type="date" required value={form.startDate} onChange={e=>setForm(p=>({...p,startDate:e.target.value}))} className={input+' w-full mt-1'}/></label>
    <label className="text-xs text-slate-500">Hasta (opcional)<input aria-label="Fecha de fin" type="date" value={form.endDate} onChange={e=>setForm(p=>({...p,endDate:e.target.value}))} className={input+' w-full mt-1'}/></label>
    <label className="text-xs text-slate-500">Cuotas (opcional)<input aria-label="Cantidad de cuotas" type="number" min={1} value={form.installmentsTotal} onChange={e=>setForm(p=>({...p,installmentsTotal:e.target.value}))} className={input+' w-full mt-1'}/></label>
    <button type="submit" disabled={busy} className="h-10 self-end rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-60">Crear gasto fijo</button>
   </form>
  </section>
 </div>;
}
