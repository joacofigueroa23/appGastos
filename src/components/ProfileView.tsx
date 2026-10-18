import React,{useEffect,useState} from 'react';
import {useAuth} from '../context/AuthContext';
import {financeApi} from '../services/financeApi';
const time=(iso:string)=>new Date(iso).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
export function ProfileView(){
 const {member,refreshMe}=useAuth();
 const [code,setCode]=useState<{code:string;expiresAt:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const linked=member?.phoneNumber;
 // Mientras haya un código vigente se consulta si el bot ya lo recibió.
 useEffect(()=>{
  if(!code||linked)return;
  const timer=setInterval(()=>void refreshMe(),3000);
  return ()=>clearInterval(timer);
 },[code,linked,refreshMe]);
 if(!member)return null;
 async function run(action:()=>Promise<unknown>){
  if(busy)return;setBusy(true);setError(null);
  try{await action();await refreshMe();}catch(e){setError(e instanceof Error?e.message:'No se pudo completar la operación.');}finally{setBusy(false);}
 }
 const button='h-10 px-4 rounded-xl text-sm font-semibold disabled:opacity-60';
 return <div className="space-y-6 max-w-2xl">
  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Mi perfil</h1>
  <section aria-label="Datos de la cuenta" className="bg-white p-4 sm:p-6 rounded-3xl space-y-1">
   <p className="text-lg font-bold">{member.name}</p>
   <p className="text-sm text-slate-500">{member.email||'Sin email'}</p>
  </section>
  <section aria-label="WhatsApp" className="bg-white p-4 sm:p-6 rounded-3xl space-y-4">
   <h2 className="text-lg font-bold">WhatsApp</h2>
   {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
   {linked?<>
    <p className="text-sm">Vinculado al número <strong>+{linked}</strong>. Los gastos que mandes desde ahí quedan a tu nombre.</p>
    <button disabled={busy} className={button+' bg-slate-100 text-slate-800'} onClick={()=>{
     if(window.confirm('¿Desvincular este WhatsApp? Dejarás de poder registrar gastos desde ese número.'))void run(async()=>{await financeApi.unlinkWhatsApp();setCode(null);});
    }}>Desvincular WhatsApp</button>
   </>:code?<>
    <p className="text-sm">Enviá este mensaje al bot de WhatsApp desde el número que querés vincular:</p>
    <p className="text-2xl font-bold tracking-wide bg-slate-50 rounded-2xl px-4 py-3 select-all">VINCULAR {code.code}</p>
    <p className="text-xs text-slate-500">Vence a las {time(code.expiresAt)} y sirve una sola vez. Esperando el mensaje…</p>
    <button disabled={busy} className={button+' bg-slate-100 text-slate-800'} onClick={()=>void run(async()=>setCode(await financeApi.createLinkCode()))}>Generar otro código</button>
   </>:<>
    <p className="text-sm text-slate-600">Vinculá tu número para registrar gastos por WhatsApp a tu nombre.</p>
    <button disabled={busy} className={button+' bg-accent text-white'} onClick={()=>void run(async()=>setCode(await financeApi.createLinkCode()))}>Vincular WhatsApp</button>
   </>}
  </section>
 </div>;
}
