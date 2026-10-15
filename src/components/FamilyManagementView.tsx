
import React,{useState} from 'react';
import {useFinance} from '../context/FinanceContext';
import {PAYMENT_LABELS,type CardType} from '../shared/apiTypes';

function ReferenceSection({kind}:{kind:'cards'|'members'}) {
 const {apiCards=[],apiMembers=[],loading,error,createDatabaseCard,updateDatabaseCard,createDatabaseMember,updateDatabaseMember}=useFinance();
 const items=kind==='cards'?apiCards:apiMembers;
 const [editing,setEditing]=useState<string|null>(null),[name,setName]=useState(''),[phone,setPhone]=useState(''),[cardType,setCardType]=useState<CardType|''>('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[failure,setFailure]=useState<string|null>(null);
 const noun=kind==='cards'?'tarjeta':'integrante';
 const reset=()=>{setEditing(null);setName('');setPhone('');setCardType('');};
 async function save(event:React.FormEvent) {
  event.preventDefault();if(busy)return;setBusy(true);setFailure(null);setMessage(null);
  try{
   if(kind==='cards'){
    const input={name,cardType:cardType||null};
    if(editing)await updateDatabaseCard!(editing,input);else await createDatabaseCard!(input);
   }else{
    const input={name,phoneNumber:phone.trim()||null};
    if(editing)await updateDatabaseMember!(editing,input);else await createDatabaseMember!(input);
   }
   setMessage(editing?'Cambios guardados.':(kind==='cards'?'Tarjeta creada.':'Integrante creado.'));reset();
  }catch(e){setFailure(e instanceof Error?e.message:'No se pudo guardar.');}finally{setBusy(false);}
 }
 async function toggle(id:string,active:boolean){
  if(busy)return;setBusy(true);setFailure(null);setMessage(null);
  try{
   if(kind==='cards')await updateDatabaseCard!(id,{active:!active});
   else await updateDatabaseMember!(id,{active:!active});
   setMessage('Estado actualizado. Los gastos históricos conservan su referencia.');
  }catch(e){setFailure(e instanceof Error?e.message:'No se pudo actualizar.');}finally{setBusy(false);}
 }
 return <section aria-label={kind==='cards'?'Gestión de tarjetas':'Gestión de integrantes'} className="bg-white p-6 rounded-2xl border border-slate-200 space-y-4">
  <h2 className="text-lg font-bold">{kind==='cards'?'Tarjetas':'Integrantes de la familia'}</h2>
  <p className="text-sm text-slate-500">{kind==='cards'?'La tarjeta identifica con qué tarjeta se realizó una compra.':'El integrante identifica quién informó el gasto; no representa una cuenta individual.'}</p>
  {failure&&<p role="alert" className="text-red-700 text-sm">{failure}</p>}
  {message&&<p role="status" className="text-green-700 text-sm">{message}</p>}
  <form onSubmit={save} className="space-y-3 border-b border-slate-100 pb-4">
   <fieldset disabled={busy||loading||!!error} className="flex flex-wrap items-end gap-3">
    <label className="flex-1 min-w-48 text-sm">Nombre *
     <input aria-label={'Nombre de '+noun} required maxLength={120} value={name} onChange={e=>setName(e.target.value)} className="w-full px-3 py-2 border rounded-xl"/>
    </label>
    {kind==='members'&&<label className="flex-1 min-w-48 text-sm">Teléfono (opcional)
     <input aria-label="Teléfono del integrante" type="tel" maxLength={40} value={phone} onChange={e=>setPhone(e.target.value)} className="w-full px-3 py-2 border rounded-xl"/>
    </label>}
    {kind==='cards'&&<label className="flex-1 min-w-48 text-sm">Tipo
     <select aria-label="Tipo de tarjeta" value={cardType} onChange={e=>setCardType(e.target.value as CardType|'')} className="w-full px-3 py-2 border rounded-xl">
      <option value="">Sin definir (indicar crédito o débito en cada gasto)</option>
      <option value="credit_card">{PAYMENT_LABELS.credit_card}</option>
      <option value="debit_card">{PAYMENT_LABELS.debit_card}</option>
     </select>
    </label>}
    <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-xl">{busy?'Guardando…':(editing?'Guardar ':'Crear ')+noun}</button>
    {editing&&<button type="button" onClick={reset} className="px-3 py-2">Cancelar edición</button>}
   </fieldset>
  </form>
  <ul className="divide-y divide-slate-100">
   {items.map(item=><li key={item.id} data-reference-id={item.id} className="py-3 flex flex-wrap justify-between gap-3">
    <div><strong className="text-sm">{item.name}</strong><span className="text-xs text-slate-500 ml-2">{item.active?'Activo':'Inactivo'}</span>
     {kind==='members'&&<p className="text-xs text-slate-500">{apiMembers.find(m=>m.id===item.id)?.phoneNumber||'Sin teléfono'}</p>}
     {kind==='cards'&&<p className="text-xs text-slate-500">{(t=>t?PAYMENT_LABELS[t]:'Tipo sin definir')(apiCards.find(c=>c.id===item.id)?.cardType)}</p>}
    </div>
    <div className="flex gap-3 text-sm">
     <button type="button" disabled={busy||loading||!!error} aria-label={'Editar '+noun+' '+item.name} onClick={()=>{setEditing(item.id);setName(item.name);setPhone(kind==='members'?(apiMembers.find(m=>m.id===item.id)?.phoneNumber||''):'');setCardType(kind==='cards'?(apiCards.find(c=>c.id===item.id)?.cardType||''):'');setMessage(null);setFailure(null);}} className="text-blue-700">Editar</button>
     <button type="button" disabled={busy||loading||!!error} aria-label={(item.active?'Desactivar ':'Activar ')+noun+' '+item.name} onClick={()=>void toggle(item.id,item.active)} className={item.active?'text-slate-600':'text-green-700'}>{item.active?'Desactivar':'Activar'}</button>
    </div>
   </li>)}
  </ul>
  {!items.length&&!loading&&!error&&<p className="text-sm text-slate-500">{kind==='cards'?'No hay tarjetas configuradas.':'No hay integrantes configurados.'}</p>}
 </section>;
}
export function FamilyManagementView(){
 const {loading,error,refresh}=useFinance();
 return <div className="space-y-6">
  <h1 className="text-2xl font-bold">Tarjetas e integrantes</h1>
  {loading&&<p role="status">Cargando…</p>}
  {error&&<p role="alert" className="text-red-700">{error} <button onClick={()=>void refresh?.()}>Reintentar</button></p>}
  <ReferenceSection kind="cards"/><ReferenceSection kind="members"/>
 </div>;
}
