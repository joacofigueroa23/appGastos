import React,{useState} from 'react';
import {Plus} from 'lucide-react';
import {useFinance} from '../context/FinanceContext';
import {useRole} from '../context/AuthContext';
import {PAYMENT_LABELS} from '../shared/apiTypes';
import {todayDateOnly,sumAmounts} from '../utils/finance';
import {BudgetSummary} from './BudgetSummary';
import {FixedSummary} from './FixedSummary';

const COLORS=['#0f766e','#d97706','#2563eb','#e11d48','#65a30d'],OTHER_COLOR='#94a3b8',MAX_SLICES=6;
const RADIUS=70,CIRCUMFERENCE=2*Math.PI*RADIUS;
type Row={name:string;total:number};
const percent=(part:number,whole:number)=>(whole?part/whole*100:0).toLocaleString('es-AR',{maximumFractionDigits:1})+'%';

// shortcut: máximo 6 porciones (el resto se agrupa en "Otras"), con más categorías conviene un gráfico de barras
function slicesOf(rows:Row[]){
 const head=rows.length>MAX_SLICES?rows.slice(0,MAX_SLICES-1):rows,rest=rows.slice(head.length);
 const slices=head.map((row,i)=>({...row,color:COLORS[i]}));
 if(rest.length)slices.push({name:'Otras categorías',total:sumAmounts(rest.map(r=>({amount:r.total}))),color:OTHER_COLOR});
 return slices;
}

function Donut({slices,total,count,format}:{slices:(Row&{color:string})[];total:number;count:number;format:(n:number)=>string}) {
 const [active,setActive]=useState<number|null>(null);
 let offset=0;
 return <div className="flex flex-col md:flex-row items-center gap-8">
  <div className="relative w-56 h-56 shrink-0">
   <svg viewBox="0 0 200 200" role="img" aria-label={'Distribución del gasto por categoría, total '+format(total)} className="w-full h-full -rotate-90">
    <circle cx="100" cy="100" r={RADIUS} fill="none" stroke="#e2e8f0" strokeWidth="26"/>
    {total>0&&slices.map((s,i)=>{
     const length=s.total/total*CIRCUMFERENCE,gap=slices.length>1?Math.min(3,length/2):0;
     const circle=<circle key={s.name} cx="100" cy="100" r={RADIUS} fill="none" stroke={s.color} strokeWidth="26"
      strokeDasharray={(length-gap)+' '+(CIRCUMFERENCE-length+gap)} strokeDashoffset={-offset}
      opacity={active===null||active===i?1:0.3} className="transition-opacity duration-150"/>;
     offset+=length;return circle;
    })}
   </svg>
   <div className="absolute inset-0 grid place-content-center text-center px-10">
    <span className="text-xs text-slate-500">Total del período</span>
    <strong className="text-xl font-bold tracking-tight">{format(total)}</strong>
    <span className="text-xs text-slate-500">{count} {count===1?'gasto':'gastos'}</span>
   </div>
  </div>
  <ul className="w-full flex-1 md:max-w-xl space-y-1">
   {slices.map((s,i)=><li key={s.name} onMouseEnter={()=>setActive(i)} onMouseLeave={()=>setActive(null)}
    className="flex items-center gap-3 rounded-xl px-2 sm:px-3 py-2 text-sm hover:bg-slate-50">
    <span className="w-3 h-3 rounded-full shrink-0" style={{background:s.color}} aria-hidden="true"/>
    <span className="flex-1 min-w-0 truncate font-medium">{s.name}</span>
    <span className="text-slate-500 md:w-14 text-right">{percent(s.total,total)}</span>
    <strong className="md:w-36 text-right">{format(s.total)}</strong>
   </li>)}
  </ul>
 </div>;
}

// Barras de los últimos 6 meses (hasta el elegido) con los mismos gastos que ya recibió el panel.
function Evolution({months,format}:{months:{label:string;total:number}[];format:(n:number)=>string}){
 const max=Math.max(0,...months.map(m=>m.total));
 return <div className="flex items-end gap-3 h-40">
  {months.map(m=><div key={m.label} className="flex-1 flex flex-col items-center justify-end gap-1 h-full min-w-0">
   <span className="text-[11px] text-slate-500 truncate max-w-full">{m.total?format(m.total):''}</span>
   <div className="w-full rounded-t-lg bg-accent" style={{height:(max?Math.max(m.total/max*100,m.total?3:0):0)+'%'}}/>
   <span className="text-xs text-slate-500">{m.label}</span>
  </div>)}
 </div>;
}
const previousMonths=(month:string,count:number)=>{
 const [y,m]=month.split('-').map(Number);
 return Array.from({length:count},(_,i)=>new Date(Date.UTC(y,m-1-(count-1-i),1)).toISOString().slice(0,7));
};
const monthLabel=(key:string)=>new Date(key+'-01T12:00:00Z').toLocaleDateString('es-AR',{month:'short',timeZone:'UTC'});

export function DatabaseDashboard({onOpenAddExpense}:{onOpenAddExpense:()=>void}) {
 const {expenses,apiExpenses=[],apiCards=[],apiMembers=[],formatCurrency,loading,error,refresh}=useFinance();
 const admin=useRole()==='admin';
 const [month,setMonth]=useState(todayDateOnly().slice(0,7)),[currency,setCurrency]=useState('ARS'),[author,setAuthor]=useState('');
 // El servidor ya entrega solo lo autorizado: un integrante recibe únicamente lo que registró.
 // 'none' = gastos históricos sin autor. Los totales de la familia son los de "Todos los integrantes" (solo administrador).
 const inScope=apiExpenses.filter(e=>e.currency===currency&&(!author||(author==='none'?!e.reportedByMemberId:e.reportedByMemberId===author)));
 const selected=inScope.filter(e=>e.date.slice(0,7)===month);
 const cardExpenses=selected.filter(e=>e.paymentMethod==='credit_card'||e.paymentMethod==='debit_card');
 const cashExpenses=selected.filter(e=>e.paymentMethod==='cash');
 const sum=(list:typeof selected)=>sumAmounts(list.map(e=>({amount:Number(e.amount)})));
 const aggregate=(key:'categoryName'|'paymentMethod'|'cardId')=>{
  const groups=new Map<string,{amount:number}[]>();
  // Por categoría se reparte cada gasto según sus conceptos (ticket con varias categorías); sin conceptos cuenta entero. Nunca las dos cosas.
  const add=(name:string,amount:string)=>{const group=groups.get(name)||[];group.push({amount:Number(amount)});groups.set(name,group);};
  (key==='cardId'?cardExpenses:selected).forEach(e=>{
   if(key==='categoryName'&&e.items?.length)e.items.forEach(i=>add(i.categoryName,i.amount));
   else add(e[key]||'Sin tarjeta especificada',e.amount);
  });
  return [...groups].map(([name,values])=>({name,total:sumAmounts(values)})).sort((a,b)=>b.total-a.total);
 };
 const money=(n:number)=>formatCurrency(n,currency);
 const total=sum(selected);
 const categories=aggregate('categoryName');
 const personal=selected.filter(e=>e.scope==='personal'),household=selected.filter(e=>e.scope==='household'),unclassified=selected.filter(e=>!e.scope);
 const byMember=(()=>{
  const groups=new Map<string,typeof selected>();
  selected.forEach(e=>{const key=e.reportedByMemberId||'none';groups.set(key,[...(groups.get(key)||[]),e]);});
  return [...groups].map(([id,list])=>({name:id==='none'?'Sin autor identificado':apiMembers.find(m=>m.id===id)?.name||'Integrante',total:sum(list)})).sort((a,b)=>b.total-a.total);
 })();
 const months=previousMonths(month,6).map(key=>({label:monthLabel(key),total:sum(inScope.filter(e=>e.date.slice(0,7)===key))}));
 const input='h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm';
 const card='bg-white p-4 sm:p-6 rounded-3xl space-y-4';
 const title={categoryName:'Gastos por Categoría',paymentMethod:'Gastos por Medio de Pago',cardId:'Gastos por Tarjeta'};
 const scopeRow=(label:string,list:typeof selected)=><div className="flex justify-between gap-3 text-sm"><span>{label} <span className="text-slate-500">({list.length})</span></span><strong>{money(sum(list))}</strong></div>;
 return <div className="space-y-6">
  <div className="flex flex-wrap items-end justify-between gap-4">
   <div>
    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{admin?'Control de Gastos del Hogar':'Mi resumen de gastos'}</h1>
    <p className="text-sm text-slate-500 mt-1">{admin?'Cómo se reparte lo gastado en el período.':'Solo se muestran los gastos que registraste vos.'}</p>
   </div>
   <div className="flex flex-wrap items-end gap-3">
    <label className="text-xs text-slate-500 flex flex-col gap-1">Mes<input aria-label="Mes del dashboard" type="month" value={month} onChange={e=>setMonth(e.target.value)} className={input}/></label>
    <select aria-label="Moneda del dashboard" value={currency} onChange={e=>setCurrency(e.target.value)} className={input}>
     {[...new Set(['ARS',...expenses.map(e=>e.currency)])].map(c=><option key={c}>{c}</option>)}
    </select>
    {admin&&<select aria-label="Integrante del dashboard" value={author} onChange={e=>setAuthor(e.target.value)} className={input}>
     <option value="">Todos los integrantes</option>
     {apiMembers.map(m=><option key={m.id} value={m.id}>{m.name}{m.active?'':' (inactivo)'}</option>)}
     <option value="none">Sin autor identificado</option>
    </select>}
    <button onClick={onOpenAddExpense} disabled={loading||!!error} className="h-10 flex items-center gap-1.5 bg-accent hover:bg-blue-700 text-white text-sm font-semibold px-4 rounded-xl transition-colors disabled:opacity-50"><Plus className="w-4 h-4" aria-hidden="true"/>Cargar Gasto</button>
   </div>
  </div>
  {loading&&<p role="status" className="text-sm text-slate-500">Cargando gastos…</p>}
  {error&&<div role="alert" className="text-red-700 text-sm">{error} <button onClick={()=>void refresh?.()} className="underline font-semibold">Reintentar</button></div>}
  {!loading&&!error&&<>
   {admin&&<BudgetSummary month={month}/>}
   {admin&&<FixedSummary month={month}/>}
   <section aria-label={title.categoryName} className={card}>
    <h2 className="text-lg font-bold">{title.categoryName}</h2>
    <Donut slices={slicesOf(categories)} total={total} count={selected.length} format={money}/>
    {!categories.length&&<p className="text-sm text-slate-500 text-center">Sin gastos para este período y moneda. Cargá un gasto o mandalo por WhatsApp para verlo acá.</p>}
   </section>
   {/* Personales y de la casa se muestran por separado; el total del gráfico es la suma de ambos y de los sin clasificar. */}
   <div className="grid lg:grid-cols-2 gap-6">
    <section aria-label={admin?'Personales y de la casa':'Mis gastos'} className={card}>
     <h2 className="text-lg font-bold">{admin?'Personales y de la casa':'Mis gastos'}</h2>
     {scopeRow(admin?'Gastos personales':'Mis gastos personales',personal)}
     {scopeRow(admin?'Gastos de la casa':'Gastos de la casa que registré',household)}
     {unclassified.length>0&&scopeRow('Sin clasificar',unclassified)}
     <p className="text-xs text-slate-500">{admin?'Cada gasto se cuenta una sola vez.':'Total registrado por vos en el período: '+money(total)+'.'}</p>
    </section>
    {admin&&<section aria-label="Gastos por integrante" className={card}>
     <h2 className="text-lg font-bold">Gastos por integrante</h2>
     {byMember.map(r=><div key={r.name} className="flex justify-between gap-3 text-sm"><span className="truncate">{r.name}</span><strong>{money(r.total)}</strong></div>)}
     {!byMember.length&&<p className="text-sm text-slate-500">Sin gastos para este período y moneda.</p>}
    </section>}
   </div>
   <section aria-label="Evolución" className={card}>
    <h2 className="text-lg font-bold">{admin&&!author?'Evolución de los últimos 6 meses':'Evolución personal de los últimos 6 meses'}</h2>
    <Evolution months={months} format={money}/>
   </section>
   <div className="grid lg:grid-cols-3 gap-6">
    {(['paymentMethod','cardId'] as const).map(key=>{
     const rows=aggregate(key),max=Math.max(0,...rows.map(r=>r.total));
     return <section key={key} aria-label={title[key]} className={card}>
      <h2 className="text-lg font-bold">{title[key]}</h2>
      {rows.map(row=><div key={row.name} className="space-y-1.5">
       <div className="flex justify-between gap-3 text-sm"><span className="truncate">{key==='paymentMethod'?PAYMENT_LABELS[row.name as keyof typeof PAYMENT_LABELS]:(apiCards.find(c=>c.id===row.name)?.name||row.name)}</span><strong>{money(row.total)}</strong></div>
       <div className="h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-accent" style={{width:(max?row.total/max*100:0)+'%'}}/></div>
      </div>)}
      {!(key==='cardId'?cardExpenses:selected).length&&<p className="text-sm text-slate-500">{key==='cardId'?'Sin gastos con tarjeta para este período y moneda.':'Sin gastos para este período y moneda.'}</p>}
     </section>;
    })}
    <section aria-label="Gastos en Efectivo" className={card}>
     <h2 className="text-lg font-bold">Gastos en Efectivo</h2>
     {cashExpenses.length>0?<div className="flex justify-between gap-3 text-sm"><span>Efectivo ({cashExpenses.length} {cashExpenses.length===1?'gasto':'gastos'})</span><strong>{money(sum(cashExpenses))}</strong></div>:<p className="text-sm text-slate-500">Sin gastos en efectivo para este período y moneda.</p>}
    </section>
   </div>
  </>}
 </div>;
}
