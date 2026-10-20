import React,{useState} from 'react';
import {useFinance} from '../context/FinanceContext';
import {useAuth} from '../context/AuthContext';
import {PAYMENT_CODES,PAYMENT_LABELS,type ApiExpense,type ExpenseWrite} from '../shared/apiTypes';
import {todayDateOnly} from '../utils/finance';
export function ManualExpenseForm({onClose,expense}:{onClose:()=>void;expense?:ApiExpense}) {
 const {categories=[],apiCards=[],apiMembers=[],activeMemberId,loading,error,createDatabaseExpense,updateDatabaseExpense,createDatabaseCard}=useFinance();
 const {mode,member}=useAuth(),session=mode==='session';
 const author=session?(expense?apiMembers.find(m=>m.id===expense.reportedByMemberId)?.name:member?.name)||'Sin autor identificado':null;
 const [form,setForm]=useState<ExpenseWrite>({
  date:expense?.date||todayDateOnly(),amount:expense?.amount||'',currency:expense?.currency||'ARS',
  merchant:expense?.merchant||null,description:expense?.description||'',categoryId:expense?.categoryId||'',
  paymentMethod:expense?.paymentMethod||'' as ExpenseWrite['paymentMethod'],cardId:expense?.cardId||null,
  reportedByMemberId:expense?expense.reportedByMemberId:session?null:activeMemberId||null,
  scope:expense?expense.scope??null:'personal',
 });
 const [saving,setSaving]=useState(false),[addingCard,setAddingCard]=useState(false);
 const [formError,setFormError]=useState<string|null>(null),[cardName,setCardName]=useState('');
 const patch=(key:keyof ExpenseWrite,value:string|null)=>setForm(p=>({...p,[key]:value}));
 const usesCard=['credit_card','debit_card'].includes(form.paymentMethod);
 async function save(e:React.FormEvent) {
  e.preventDefault();if(saving||addingCard)return;setFormError(null);
  setSaving(true);
  try{
   const input={...form,amount:form.amount.trim().replace(',','.'),merchant:form.merchant?.trim()||null,cardId:usesCard?form.cardId:null};
   if(expense)await updateDatabaseExpense!(expense.id,input);else await createDatabaseExpense!(input);
   onClose();
  }catch(e){setFormError(e instanceof Error?e.message:'No se pudo guardar.');}finally{setSaving(false);}
 }
 async function addCard(){
  if(!cardName.trim())return;setAddingCard(true);setFormError(null);
  try{await createDatabaseCard!({name:cardName.trim()});setCardName('');}
  catch(e){setFormError(e instanceof Error?e.message:'No se pudo crear la tarjeta.');}finally{setAddingCard(false);}
 }
 const cls='w-full text-sm px-3 py-2 border border-slate-300 rounded-xl';
 return <div role="dialog" aria-modal="true" aria-label={expense?'Editar gasto':'Registrar gasto'} className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
  <form onSubmit={save} className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
   <h2 className="text-lg font-bold">{expense?'Editar gasto':'Registrar Nuevo Gasto'}</h2>
   <p className="text-xs text-slate-500">Una economía familiar. El integrante identifica quién informó el gasto.</p>
   {(formError||error)&&<p role="alert" className="text-sm text-red-700">{formError||error}</p>}
   <fieldset disabled={saving||addingCard||loading||!!error} className="space-y-3">
    <label className="block">Descripción *<input aria-label="Descripción" className={cls} required maxLength={1000} value={form.description} onChange={e=>patch('description',e.target.value)}/></label>
    <div className="grid grid-cols-2 gap-3">
     <label>Monto *<input aria-label="Monto" className={cls} type="number" required min="0.01" step="0.01" value={form.amount} onChange={e=>patch('amount',e.target.value)}/></label>
     <label>Fecha *<input aria-label="Fecha" className={cls} type="date" required value={form.date} onChange={e=>patch('date',e.target.value)}/></label>
    </div>
    <label className="block">Moneda<select aria-label="Moneda" className={cls} value={form.currency} onChange={e=>patch('currency',e.target.value)}>
     {[...new Set(['ARS','USD','EUR',form.currency])].map(c=><option key={c} value={c}>{c}</option>)}
    </select></label>
    <label className="block">Ámbito<select aria-label="Ámbito" className={cls} value={form.scope||''} onChange={e=>setForm(p=>({...p,scope:(e.target.value||null) as ExpenseWrite['scope']}))}>
     {!form.scope&&<option value="">Sin clasificar</option>}<option value="personal">Personal</option><option value="household">De la casa</option>
    </select></label>
    <label className="block">Comercio<input aria-label="Comercio" className={cls} maxLength={200} value={form.merchant||''} onChange={e=>patch('merchant',e.target.value||null)}/></label>
    <label className="block">Categoría *<select aria-label="Categoría" className={cls} required value={form.categoryId} onChange={e=>patch('categoryId',e.target.value)}>
     <option value="">Selecciona una categoría</option>
     {categories.filter(c=>c.active||c.id===expense?.categoryId).map(c=><option key={c.id} value={c.id}>{c.name}{c.active?'':' (inactiva)'}</option>)}
    </select></label>
    <label className="block">Medio de pago *<select aria-label="Medio de pago" className={cls} required value={form.paymentMethod} onChange={e=>setForm(p=>({...p,paymentMethod:e.target.value as ExpenseWrite['paymentMethod'],cardId:null}))}>
     <option value="">Selecciona un medio de pago</option>{PAYMENT_CODES.map(c=><option key={c} value={c}>{PAYMENT_LABELS[c]}</option>)}
    </select></label>
    {usesCard&&<div className="space-y-2">
     <label className="block">Tarjeta (opcional)<select aria-label="Tarjeta opcional" className={cls} value={form.cardId||''} onChange={e=>patch('cardId',e.target.value||null)}>
      <option value="">Sin tarjeta especificada</option>{apiCards.filter(c=>(c.active||c.id===expense?.cardId)&&(!c.cardType||c.cardType===form.paymentMethod||(c.id===expense?.cardId&&form.paymentMethod===expense?.paymentMethod))).map(c=><option key={c.id} value={c.id}>{c.name}{c.active?'':' (inactiva)'}</option>)}
     </select></label>
     <div className="flex gap-2"><input aria-label="Nombre de nueva tarjeta" placeholder="Nombre de nueva tarjeta" className={cls} maxLength={120} value={cardName} onChange={e=>setCardName(e.target.value)}/>
      <button type="button" disabled={!cardName.trim()} onClick={addCard} className="text-sm text-blue-700">Agregar tarjeta</button></div>
    </div>}
    {session?<p className="text-sm">Registrado por: <strong>{author}</strong></p>:<label className="block">Informado por<select aria-label="Informado por" className={cls} value={form.reportedByMemberId||''} onChange={e=>patch('reportedByMemberId',e.target.value||null)}>
     <option value="">Sin integrante especificado</option>{apiMembers.filter(m=>m.active||m.id===expense?.reportedByMemberId).map(m=><option key={m.id} value={m.id}>{m.name}{m.active?'':' (inactivo)'}</option>)}
    </select></label>}
   </fieldset>
   <div className="flex justify-end gap-3"><button type="button" disabled={saving||addingCard} onClick={onClose}>Cancelar</button>
    <button type="submit" disabled={saving||addingCard||loading||!!error} className="bg-blue-600 text-white px-4 py-2 rounded-xl">{saving?'Guardando…':'Guardar Gasto'}</button></div>
  </form>
 </div>;
}
