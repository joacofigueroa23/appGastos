import React,{useCallback,useEffect,useState} from 'react';
import {financeApi} from '../services/financeApi';
import {useFinance} from '../context/FinanceContext';
import {useRole} from '../context/AuthContext';
import {PAYMENT_CODES,PAYMENT_LABELS} from '../shared/apiTypes';
import {categoryLabel,sortedCategories} from '../utils/categories';
import type {DocumentDto,DocumentKind,DocumentState,DraftLine,ReceiptDraft,StatementDraft,InvoiceDraft} from '../shared/documentTypes';
const KIND:Record<string,string>={purchase_receipt:'Ticket de compra',pending_invoice:'Factura pendiente',payment_receipt:'Comprobante de pago',card_statement:'Resumen de tarjeta',unknown:'Sin clasificar'};
const STATE:Record<DocumentState,[string,string]>={received:['Leyendo','bg-slate-100 text-slate-700'],processing:['Leyendo','bg-slate-100 text-slate-700'],needs_review:['Para revisar','bg-amber-100 text-amber-800'],confirmed:['Registrado','bg-green-100 text-green-800'],cancelled:['Descartado','bg-slate-100 text-slate-500'],failed:['No se pudo leer','bg-red-100 text-red-800']};
const dmy=(d:string|null)=>d?d.slice(8)+'/'+d.slice(5,7)+'/'+d.slice(0,4):'sin fecha';
// Comprobantes que llegan por WhatsApp. Leer un documento no lo registra: acá se revisa, se corrige y se confirma.
// Cada integrante ve los suyos; el administrador, además, las facturas pendientes de todos.
export function DocumentsView(){
 const {categories=[],apiCards=[],formatCurrency,refresh}=useFinance();
 const admin=useRole()==='admin';
 const [list,setList]=useState<DocumentDto[]>([]),[doc,setDoc]=useState<DocumentDto|null>(null),[occurrence,setOccurrence]=useState('');
 const [newFixedCategory,setNewFixedCategory]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
 const loadList=useCallback(async()=>{try{setList((await financeApi.documents()).documents);}catch(e){setError(e instanceof Error?e.message:'No se pudieron cargar los comprobantes.');}},[]);
 useEffect(()=>{void loadList();},[loadList]);
 // Mientras haya comprobantes leyéndose, se consulta cada pocos segundos para que aparezca el resultado.
 const reading=list.some(d=>d.state==='received'||d.state==='processing');
 useEffect(()=>{if(!reading)return;const t=setInterval(()=>void loadList(),5000);return ()=>clearInterval(t);},[reading,loadList]);
 async function open(id:string){setError(null);setMessage(null);setOccurrence('');setNewFixedCategory('');try{setDoc((await financeApi.document(id)).document);}catch(e){setError(e instanceof Error?e.message:'No se pudo abrir el comprobante.');}}
 async function run(action:()=>Promise<void>){
  if(busy)return;setBusy(true);setError(null);setMessage(null);
  try{await action();}catch(e){setError(e instanceof Error?e.message:'No se pudo completar la operación.');}finally{setBusy(false);}
 }
 // Cada corrección se guarda en el servidor (no crea movimientos ni vuelve a llamar al modelo) y devuelve el borrador actualizado.
 const edit=(edits:unknown[])=>run(async()=>{if(!doc)return;const r=await financeApi.editDocument(doc.id,{edits});setDoc({...r.document,occurrences:doc.occurrences});});
 const changeKind=(kind:DocumentKind)=>run(async()=>{if(!doc)return;const r=await financeApi.editDocument(doc.id,{kind});setDoc({...r.document,occurrences:doc.occurrences});});
 const confirm=(input:{occurrenceId?:string;newFixedCategoryId?:string}={})=>run(async()=>{
  if(!doc)return;const r=await financeApi.confirmDocument(doc.id,input);setDoc(r.document);setMessage(r.message);await Promise.all([loadList(),refresh?.()]);
 });
 // Subida desde la web: foto, PDF, CSV o Excel. Se lee en el momento y queda un borrador para revisar; no registra nada.
 const upload=(file:File|undefined)=>run(async()=>{
  if(!file)return;
  if(file.size>10*1024*1024)throw new Error('El archivo es demasiado grande (máximo 10 MB).');
  const bytes=new Uint8Array(await file.arrayBuffer());let bin='';
  for(let i=0;i<bytes.length;i+=8192)bin+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const r=await financeApi.uploadDocument(file.name,btoa(bin));
  setDoc(r.document);setMessage('Listo, leí el archivo. Revisalo antes de confirmar: todavía no se registró nada.');await loadList();
 });
 const cancel=()=>run(async()=>{if(!doc)return;const r=await financeApi.cancelDocument(doc.id);setDoc(r.document);setMessage(r.message);await loadList();});
 const money=(v:string|null,cur='ARS')=>v===null?'sin importe':formatCurrency(Number(v),cur);
 const input='h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm',card='bg-white p-4 sm:p-6 rounded-3xl space-y-4';
 const catSelect=(value:string|null,onChange:(id:string|null)=>void,label:string,disabled=false)=>
  <select aria-label={label} disabled={disabled||busy} value={value||''} onChange={e=>onChange(e.target.value||null)} className={input+' max-w-44'}>
   <option value="">(sin categoría)</option>{sortedCategories(categories.filter(c=>c.active||c.id===value)).map(c=><option key={c.id} value={c.id}>{categoryLabel(c,categories)}</option>)}
  </select>;
 const notes=(n:string[])=>n.length>0&&<ul className="text-xs text-amber-800 space-y-0.5">{n.map(x=><li key={x}>⚠️ {x}</li>)}</ul>;

 const receipt=(d:ReceiptDraft)=><div className="space-y-4">
  <div className="grid sm:grid-cols-4 gap-3">
   <label className="text-xs text-slate-500">Fecha<input aria-label="Fecha del comprobante" type="date" value={d.date||''} disabled={busy} onChange={e=>e.target.value&&void edit([{type:'date',value:e.target.value}])} className={input+' w-full block'}/></label>
   <label className="text-xs text-slate-500">Total ({d.currency})<input aria-label="Total del comprobante" key={d.total||'x'} defaultValue={d.total||''} disabled={busy} className={input+' w-full block'}
    onBlur={e=>{const v=e.target.value.trim().replace(',','.');if(v&&v!==d.total)void edit([{type:'total',value:v}]);}}/></label>
   <label className="text-xs text-slate-500">Ámbito<select aria-label="Ámbito del comprobante" value={d.scope} disabled={busy} onChange={e=>void edit([{type:'scope',value:e.target.value}])} className={input+' w-full block'}><option value="personal">Personal</option><option value="household">De la casa</option></select></label>
   <label className="text-xs text-slate-500">Medio de pago<select aria-label="Medio de pago del comprobante" value={d.paymentMethod||''} disabled={busy} onChange={e=>e.target.value&&void edit([{type:'paymentMethod',value:e.target.value}])} className={input+' w-full block'}><option value="">Elegir…</option>{PAYMENT_CODES.map(c=><option key={c} value={c}>{PAYMENT_LABELS[c]}</option>)}</select></label>
  </div>
  {(d.paymentMethod==='credit_card'||d.paymentMethod==='debit_card')&&<label className="text-xs text-slate-500 block">Tarjeta (opcional)<select aria-label="Tarjeta del comprobante" value={d.cardId||''} disabled={busy} onChange={e=>void edit([{type:'cardId',value:e.target.value||null}])} className={input+' block'}><option value="">Sin tarjeta especificada</option>{apiCards.filter(c=>c.active).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
  {!d.noExpense&&!d.linkExpenseId&&<div className="space-y-2">
   <h3 className="text-sm font-bold">Conceptos</h3>
   {d.items.map(i=><div key={i.id} className={'flex flex-wrap items-center justify-between gap-3 text-sm '+(i.excluded?'opacity-40':'')}>
    <span className="min-w-0 flex-1 truncate">{i.adjustment&&<span className="text-xs text-amber-800 mr-1">Ajuste</span>}{i.description}</span>
    <strong>{money(i.amount,d.currency)}</strong>
    {catSelect(i.categoryId,id=>void edit([{type:'itemCategory',itemId:i.id,categoryId:id}]),'Categoría de '+i.description,i.excluded)}
    {!i.adjustment&&<button disabled={busy} className="text-xs text-blue-700" onClick={()=>void edit([{type:'itemExcluded',itemId:i.id,excluded:!i.excluded}])}>{i.excluded?'Incluir':'Excluir'}</button>}
   </div>)}
   <p className="text-xs text-slate-500">Los conceptos y los ajustes suman el total del comprobante. Un ajuste es una diferencia (descuento, recargo o redondeo) que tenés que asignar a una categoría.</p>
  </div>}
  {d.duplicates.length>0&&!d.noExpense&&<div className="rounded-2xl bg-amber-50 p-3 space-y-2 text-sm">
   <p className="font-medium">Ya hay un gasto parecido. ¿Es el mismo?</p>
   {d.duplicates.map(x=><label key={x.expenseId} className="flex items-center gap-2"><input type="radio" name="dup" checked={d.linkExpenseId===x.expenseId} onChange={()=>void edit([{type:'link',expenseId:x.expenseId}])}/>
    <span>{money(x.amount,x.currency)} · {dmy(x.date)}{x.label?' · '+x.label:''}{x.author?' · cargó '+x.author:''}</span></label>)}
   <label className="flex items-center gap-2"><input type="radio" name="dup" checked={!d.linkExpenseId} onChange={()=>void edit([{type:'link',expenseId:null}])}/><span>No, es un gasto nuevo</span></label>
  </div>}
  {d.settle&&!d.noExpense&&!d.linkExpenseId&&<div className="rounded-2xl bg-blue-50 p-3 space-y-2 text-sm">
   <p className="font-medium">Corresponde al gasto fijo «{d.settle.label}».</p>
   <p className="text-xs text-slate-600">Al confirmar se registra UN gasto de la casa y la obligación queda pagada. Un pago de gasto fijo no descuenta de los presupuestos variables.</p>
   <button disabled={busy} className="text-xs text-blue-700" onClick={()=>void edit([{type:'settle',occurrenceId:null}])}>No es ese gasto fijo</button>
  </div>}
  {d.kind==='payment_receipt'&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.noExpense} disabled={busy} onChange={e=>void edit([{type:'noExpense',value:e.target.checked}])}/>No es un gasto (transferencia entre mis cuentas o pago de tarjeta)</label>}
  {d.noExpense&&d.noExpenseReason&&<p className="text-xs text-slate-600">{d.noExpenseReason}</p>}
  {notes(d.notes)}
  <div className="flex flex-wrap gap-3 pt-1">
   <button disabled={busy} onClick={()=>void confirm()} className="h-10 px-4 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-60">{d.noExpense?'Confirmar sin registrar gasto':d.linkExpenseId?'Asociar al gasto existente':d.settle?'Confirmar y marcar como pagada':'Confirmar y registrar'}</button>
   <button disabled={busy} onClick={()=>void cancel()} className="h-10 px-4 rounded-xl bg-slate-100 text-sm font-semibold">Descartar</button>
  </div>
 </div>;

 const lineRow=(l:DraftLine,d:StatementDraft)=><div key={l.id} className={'grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_6rem_1fr_8rem_11rem_8rem] items-center gap-2 text-sm '+(l.blockedReason?'opacity-70':'')}>
  <input aria-label={'Importar '+l.merchant} type="checkbox" checked={!l.excluded} disabled={busy||!!l.blockedReason} onChange={e=>void edit([{type:'lineExcluded',lineId:l.id,excluded:!e.target.checked}])}/>
  <span className="hidden sm:block text-slate-500">{dmy(l.date)}</span>
  <span className="min-w-0 truncate">{l.merchant}{l.installment?` · cuota ${l.installment.current}/${l.installment.total}`:''}
   {l.blockedReason&&<span className="block text-xs text-amber-800">{({installment:'Cuota ya registrada al inicio de la compra: no se cuenta otra vez.',refund:'Devolución sin gasto original para restar: no se importa.',payment:'Pago del resumen anterior: no es un consumo.',no_date:'Sin fecha legible.',no_amount:'Sin importe.'} as Record<string,string>)[l.blockedReason]}</span>}
   {l.installment&&!l.blockedReason&&<span className="block text-xs text-slate-600">Se registra la compra completa: {money(String(Number(l.amount)*l.installment.total),l.currency)} en {l.installment.total} cuotas.</span>}
   {l.kind==='refund'&&l.refundCandidates.length>0&&<label className="block text-xs text-slate-600">Restar de<select aria-label={'Gasto original de '+l.merchant} value={l.refundOf||''} disabled={busy} onChange={e=>void edit([{type:'lineRefundOf',lineId:l.id,expenseId:e.target.value||null}])} className={input+' block max-w-72'}><option value="">Elegir el gasto original…</option>{l.refundCandidates.map(c=><option key={c.expenseId} value={c.expenseId}>{money(c.amount,c.currency)} · {dmy(c.date)}{c.label?' · '+c.label:''}</option>)}</select></label>}
   {l.duplicates.length>0&&<label className="flex items-center gap-1 text-xs text-amber-800"><input type="checkbox" checked={l.acceptDuplicate} disabled={busy} onChange={e=>void edit([{type:'lineAcceptDuplicate',lineId:l.id,value:e.target.checked}])}/>Ya cargado ({money(l.duplicates[0].amount,l.duplicates[0].currency)}, {dmy(l.duplicates[0].date)}): importar igual</label>}</span>
  <strong className="text-right">{l.kind==='refund'||l.kind==='payment'?'−':''}{money(l.amount,l.currency)} {l.currency!=='ARS'?l.currency:''}</strong>
  {catSelect(l.categoryId,id=>void edit([{type:'lineCategory',lineId:l.id,categoryId:id}]),'Categoría de '+l.merchant,!!l.blockedReason)}
  <select aria-label={'Ámbito de '+l.merchant} disabled={busy||!!l.blockedReason} value={l.scope} onChange={e=>void edit([{type:'lineScope',lineId:l.id,value:e.target.value}])} className={input}><option value="personal">Personal</option><option value="household">De la casa</option></select>
 </div>;
 const statement=(d:StatementDraft)=><div className="space-y-4">
  <p className="text-sm text-slate-600">Elegí qué consumos importar. El total del resumen no es un gasto. Una compra en cuotas se registra una sola vez, por el total, con la cantidad de meses (las cuotas siguientes no se cuentan). Una devolución se resta del gasto original que elijas. Los pagos del resumen anterior no son consumos.</p>
  <label className="text-xs text-slate-500 block">Tarjeta (opcional)<select aria-label="Tarjeta del resumen" value={d.cardId||''} disabled={busy} onChange={e=>void edit([{type:'cardId',value:e.target.value||null}])} className={input+' block'}><option value="">Sin tarjeta especificada</option>{apiCards.filter(c=>c.active).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
  <div className="space-y-2 overflow-x-auto">{d.lines.map(l=>lineRow(l,d))}</div>
  {byCategory(d)}
  <div className="space-y-1 text-sm">{d.totals.map(t=><p key={t.currency}><strong>{t.currency}</strong>: consumos del resumen {money(t.lines,t.currency)}{t.statement?` · total declarado ${money(t.statement,t.currency)}`:''}{t.statement&&t.statement!==t.lines?<span className="text-amber-800"> (no coinciden: revisá)</span>:null}</p>)}</div>
  {notes(d.notes)}
  <div className="flex flex-wrap gap-3"><button disabled={busy} onClick={()=>void confirm()} className="h-10 px-4 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-60">Importar los seleccionados</button>
   <button disabled={busy} onClick={()=>void cancel()} className="h-10 px-4 rounded-xl bg-slate-100 text-sm font-semibold">Descartar</button></div>
 </div>;
 // Cuánto se importaría por categoría (solo lo seleccionado): el análisis del archivo.
 const byCategory=(d:StatementDraft)=>{
  const sums=new Map<string,number>();
  for(const l of d.lines.filter(x=>!x.excluded&&x.kind!=='refund')){
   const name=categories.find(c=>c.id===l.categoryId)?.name||'Sin categoría',total=Number(l.amount)*(l.installment?l.installment.total:1);
   sums.set(name+'|'+l.currency,(sums.get(name+'|'+l.currency)||0)+total);
  }
  if(!sums.size)return null;
  return <div aria-label="Resumen por categoría" className="rounded-2xl bg-slate-50 p-3 space-y-1 text-sm"><h3 className="font-bold">Por categoría (lo seleccionado)</h3>
   {[...sums.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=><p key={k} className="flex justify-between"><span>{k.split('|')[0]}</span><strong>{money(String(Math.round(v*100)/100),k.split('|')[1])}</strong></p>)}</div>;
 };
 const invoice=(d:InvoiceDraft,mine:boolean)=><div className="space-y-4 text-sm">
  <p>{d.issuer||'Factura'}{d.concept?' · '+d.concept:''}{d.period?' · '+d.period:''}</p>
  <p><strong>{money(d.amount,d.currency)}</strong>{d.dueDate?' · vence '+dmy(d.dueDate):''}{d.reference?' · N° '+d.reference:''}</p>
  <p className="text-slate-600">Una factura no es un gasto pagado: no se registra como tal. {admin?'Asocialo al gasto fijo que corresponde para actualizar su importe y vencimiento previstos; la obligación sigue pendiente hasta que registres el pago.':'Un administrador la revisa.'}</p>
  {notes(d.notes)}
  {admin&&<div className="flex flex-wrap items-end gap-3">
   <label className="text-xs text-slate-500">Gasto fijo<select aria-label="Gasto fijo de la factura" value={occurrence} disabled={busy} onChange={e=>setOccurrence(e.target.value)} className={input+' block'}><option value="">Elegir…</option>{(doc?.occurrences||[]).map(o=><option key={o.id} value={o.id}>{o.name} · {o.month} · vence {dmy(o.dueDate)}</option>)}</select></label>
   <button disabled={busy||!occurrence} onClick={()=>void confirm({occurrenceId:occurrence})} className="h-9 px-4 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-40">Asociar</button></div>}
  {admin&&d.amount&&d.dueDate&&<div className="flex flex-wrap items-end gap-3">
   <label className="text-xs text-slate-500">Si no existe, crear la obligación en la categoría<select aria-label="Categoría de la obligación nueva" value={newFixedCategory} disabled={busy} onChange={e=>setNewFixedCategory(e.target.value)} className={input+' block'}><option value="">Elegir…</option>{sortedCategories(categories.filter(c=>c.active)).map(c=><option key={c.id} value={c.id}>{categoryLabel(c,categories)}</option>)}</select></label>
   <button disabled={busy||!newFixedCategory} onClick={()=>void confirm({newFixedCategoryId:newFixedCategory})} className="h-9 px-4 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-40">Crear obligación pendiente</button></div>}
  {(admin||mine)&&<button disabled={busy} onClick={()=>void cancel()} className="h-9 px-4 rounded-xl bg-slate-100 text-sm font-semibold">Descartar</button>}
 </div>;
 const body=()=>{
  if(!doc)return null;
  if(doc.state==='needs_review'){
   const d=doc.draft;
   if(!d)return <div className="space-y-3 text-sm"><p>No pude determinar qué tipo de documento es. Elegí cuál es:</p>
    <div className="flex flex-wrap gap-2">{(['purchase_receipt','pending_invoice','payment_receipt','card_statement'] as DocumentKind[]).map(k=><button key={k} disabled={busy} onClick={()=>void changeKind(k)} className="h-9 px-3 rounded-xl bg-slate-100 text-sm font-semibold">{KIND[k]}</button>)}</div>
    <button disabled={busy} onClick={()=>void cancel()} className="h-9 px-4 rounded-xl bg-slate-100 text-sm font-semibold">Descartar</button></div>;
   return d.kind==='card_statement'?statement(d):d.kind==='pending_invoice'?invoice(d,doc.mine):receipt(d);
  }
  if(doc.state==='failed')return <p className="text-sm text-red-700">No pude leer este comprobante. Probá con una foto más nítida o cargá el gasto a mano.</p>;
  if(doc.state==='confirmed'){
   // "Registrado" = el comprobante se cerró; no siempre crea un gasto. Se dice qué pasó.
   const r=doc.result||{};
   const text=r.noExpense?'Se cerró SIN crear un gasto'+(r.reason?': '+String(r.reason):'.')+' Si sí era un gasto, cargalo a mano desde el Historial.'
    :r.linkedExpenseId?'Se asoció a un gasto que ya tenías cargado (no se creó otro). Lo ves en el Historial de Gastos.'
    :r.occurrenceId?'Se asoció a una obligación pendiente: sigue sin pagar y no es un gasto.'
    :'Ya está registrado. Los movimientos se ven en el Historial de Gastos.';
   return <p className={'text-sm '+(r.noExpense?'text-amber-800':'text-green-700')}>{text}</p>;
  }
  if(doc.state==='cancelled')return <p className="text-sm text-slate-500">Descartado: no se registró nada.</p>;
  return <p role="status" className="text-sm text-slate-500">Estoy leyendo el comprobante…</p>;
 };
 return <div className="space-y-6">
  <div><h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Comprobantes</h1>
   <p className="text-sm text-slate-500 mt-1">Mandá una foto o un PDF de un ticket, una factura, un comprobante de pago o un resumen de tarjeta por WhatsApp, o subí acá un archivo (foto, PDF, CSV o Excel). Leerlo no lo registra: lo revisás y lo confirmás.</p>
   <label className="mt-3 inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-accent text-white text-sm font-semibold cursor-pointer">Subir archivo<input aria-label="Subir archivo" type="file" accept=".jpg,.jpeg,.png,.pdf,.csv,.xlsx" className="sr-only" disabled={busy} onChange={e=>{const f=e.target.files?.[0];e.target.value='';void upload(f);}}/></label></div>
  {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
  {message&&<p role="status" className="text-sm text-green-700">{message}</p>}
  <section aria-label="Lista de comprobantes" className={card}>
   {list.map(d=><button key={d.id} onClick={()=>void open(d.id)} className={'w-full flex flex-wrap items-center justify-between gap-3 text-left text-sm rounded-xl px-3 py-2 hover:bg-slate-50 '+(doc?.id===d.id?'bg-slate-50':'')}>
    <span className="min-w-0"><strong>{KIND[d.kind||'unknown']}</strong><span className="text-slate-500"> · {dmy(d.createdAt.slice(0,10))} · código {d.shortCode}{d.author&&!d.mine?' · de '+d.author:''}</span></span>
    <span className={'text-xs px-2 py-1 rounded-lg '+STATE[d.state][1]}>{STATE[d.state][0]}</span></button>)}
   {!list.length&&<p className="text-sm text-slate-500">Todavía no mandaste ningún comprobante. Mandalo por WhatsApp al bot.</p>}
  </section>
  {doc&&<section aria-label="Detalle del comprobante" className={card}>
   <h2 className="text-lg font-bold">{KIND[doc.kind||'unknown']} <span className="text-sm font-normal text-slate-500">· código {doc.shortCode}</span></h2>
   {body()}
  </section>}
 </div>;
}
