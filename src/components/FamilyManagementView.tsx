
import React,{useState} from 'react';
import {useFinance} from '../context/FinanceContext';
import {useAuth} from '../context/AuthContext';
import {financeApi} from '../services/financeApi';
import {sortedCategories} from '../utils/categories';
import {PAYMENT_LABELS,type CardType} from '../shared/apiTypes';

function ReferenceSection({kind}:{kind:'cards'|'members'}) {
 const {mode}=useAuth(),session=mode==='session';
 const {apiCards=[],apiMembers=[],refresh,loading,error,createDatabaseCard,updateDatabaseCard,createDatabaseMember,updateDatabaseMember}=useFinance();
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
 async function changeRole(id:string,role:'admin'|'member'){
  if(busy)return;setBusy(true);setFailure(null);setMessage(null);
  try{await financeApi.setRole(id,role);await refresh?.();setMessage(role==='admin'?'Ahora es administrador.':'Ya no es administrador.');}
  catch(e){setFailure(e instanceof Error?e.message:'No se pudo cambiar el rol.');}finally{setBusy(false);}
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
    <div><strong className="text-sm">{item.name}</strong><span className="text-xs text-slate-500 ml-2">{item.active?'Activo':'Inactivo'}{kind==='members'&&apiMembers.find(m=>m.id===item.id)?.linked?' · Con cuenta':''}{kind==='members'&&apiMembers.find(m=>m.id===item.id)?.role==='admin'?' · Administrador':''}</span>
     {kind==='members'&&<p className="text-xs text-slate-500">{apiMembers.find(m=>m.id===item.id)?.phoneNumber||'Sin teléfono'}</p>}
     {kind==='cards'&&<p className="text-xs text-slate-500">{(t=>t?PAYMENT_LABELS[t]:'Tipo sin definir')(apiCards.find(c=>c.id===item.id)?.cardType)}</p>}
    </div>
    <div className="flex gap-3 text-sm">
     <button type="button" disabled={busy||loading||!!error} aria-label={'Editar '+noun+' '+item.name} onClick={()=>{setEditing(item.id);setName(item.name);setPhone(kind==='members'?(apiMembers.find(m=>m.id===item.id)?.phoneNumber||''):'');setCardType(kind==='cards'?(apiCards.find(c=>c.id===item.id)?.cardType||''):'');setMessage(null);setFailure(null);}} className="text-blue-700">Editar</button>
     <button type="button" disabled={busy||loading||!!error} aria-label={(item.active?'Desactivar ':'Activar ')+noun+' '+item.name} onClick={()=>void toggle(item.id,item.active)} className={item.active?'text-slate-600':'text-green-700'}>{item.active?'Desactivar':'Activar'}</button>
     {session&&kind==='members'&&apiMembers.find(m=>m.id===item.id)?.linked&&(m=>m&&<button type="button" disabled={busy||loading||!!error} aria-label={(m.role==='admin'?'Quitar rol de administrador a ':'Hacer administrador a ')+item.name} onClick={()=>void changeRole(item.id,m.role==='admin'?'member':'admin')} className="text-blue-700">{m.role==='admin'?'Quitar administrador':'Hacer administrador'}</button>)(apiMembers.find(m=>m.id===item.id))}
    </div>
   </li>)}
  </ul>
  {!items.length&&!loading&&!error&&<p className="text-sm text-slate-500">{kind==='cards'?'No hay tarjetas configuradas.':'No hay integrantes configurados.'}</p>}
 </section>;
}
// Categorías y subcategorías (solo administradores; el servidor lo exige igual). Dos niveles. Nunca se borran: se archivan y conservan su historial;
// reorganizarlas no reclasifica ningún gasto.
function CategoriesSection(){
 const {categories=[],refresh}=useFinance();
 const [name,setName]=useState(''),[parent,setParent]=useState('');
 const [edits,setEdits]=useState<Record<string,{name:string;parentId:string}>>({});
 const [busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[failure,setFailure]=useState<string|null>(null);
 const roots=categories.filter(c=>!c.parentId&&c.active);
 async function run(action:()=>Promise<unknown>,ok:string){
  if(busy)return;setBusy(true);setFailure(null);setMessage(null);
  try{await action();await refresh?.();setMessage(ok);}catch(e){setFailure(e instanceof Error?e.message:'No se pudo guardar.');}finally{setBusy(false);}
 }
 return <section aria-label="Gestión de categorías" className="bg-white p-6 rounded-2xl border border-slate-200 space-y-4">
  <h2 className="text-lg font-bold">Categorías y subcategorías</h2>
  <p className="text-sm text-slate-500">Una categoría principal puede tener subcategorías (máximo dos niveles). El presupuesto de la principal incluye a sus subcategorías. No se borran: se archivan y los gastos anteriores conservan su categoría.</p>
  {failure&&<p role="alert" className="text-red-700 text-sm">{failure}</p>}
  {message&&<p role="status" className="text-green-700 text-sm">{message}</p>}
  <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 pb-4" onSubmit={e=>{e.preventDefault();void run(async()=>{await financeApi.createCategory({name:name.trim(),parentId:parent||null});setName('');setParent('');},'Categoría creada.');}}>
   <label className="flex-1 min-w-48 text-sm">Nombre *<input aria-label="Nombre de la categoría" required maxLength={120} value={name} onChange={e=>setName(e.target.value)} className="w-full px-3 py-2 border rounded-xl"/></label>
   <label className="text-sm">Dentro de<select aria-label="Categoría principal" value={parent} onChange={e=>setParent(e.target.value)} className="px-3 py-2 border rounded-xl block"><option value="">(es principal)</option>{roots.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <button type="submit" disabled={busy} className="px-4 py-2 bg-blue-600 text-white rounded-xl disabled:opacity-60">Crear categoría</button>
  </form>
  <ul className="divide-y divide-slate-100">
   {sortedCategories(categories).map(c=>{
    const e=edits[c.id]??{name:c.name,parentId:c.parentId||''},hasChildren=categories.some(x=>x.parentId===c.id),changed=e.name.trim()!==c.name||e.parentId!==(c.parentId||'');
    return <li key={c.id} className={'py-2 flex flex-wrap items-center gap-3 text-sm '+(c.parentId?'pl-6':'')}>
     <input aria-label={'Nombre de '+c.name} value={e.name} maxLength={120} onChange={ev=>setEdits(p=>({...p,[c.id]:{...e,name:ev.target.value}}))} className="h-9 px-2 border rounded-lg min-w-40"/>
     <select aria-label={'Principal de '+c.name} disabled={hasChildren} title={hasChildren?'Tiene subcategorías: no puede pasar a ser subcategoría':''} value={e.parentId} onChange={ev=>setEdits(p=>({...p,[c.id]:{...e,parentId:ev.target.value}}))} className="h-9 px-2 border rounded-lg"><option value="">(principal)</option>{roots.filter(r=>r.id!==c.id).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select>
     <button disabled={busy||!changed||!e.name.trim()} className="h-9 px-3 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-40" onClick={()=>void run(async()=>{await financeApi.updateCategory(c.id,{name:e.name.trim(),parentId:e.parentId||null});setEdits(p=>{const n={...p};delete n[c.id];return n;});},'Categoría actualizada.')}>Guardar</button>
     <button disabled={busy} aria-label={(c.active?'Archivar ':'Reactivar ')+c.name} className={c.active?'text-slate-600':'text-green-700'} onClick={()=>void run(()=>financeApi.updateCategory(c.id,{active:!c.active}),c.active?'Categoría archivada.':'Categoría reactivada.')}>{c.active?'Archivar':'Reactivar'}</button>
     {!c.active&&<span className="text-xs text-slate-500">Archivada</span>}
    </li>;
   })}
  </ul>
 </section>;
}
export function FamilyManagementView(){
 const {loading,error,refresh}=useFinance();
 return <div className="space-y-6">
  <h1 className="text-2xl font-bold">Tarjetas e integrantes</h1>
  {loading&&<p role="status">Cargando…</p>}
  {error&&<p role="alert" className="text-red-700">{error} <button onClick={()=>void refresh?.()}>Reintentar</button></p>}
  <ReferenceSection kind="cards"/><ReferenceSection kind="members"/><CategoriesSection/>
 </div>;
}
