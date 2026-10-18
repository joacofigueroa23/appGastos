import React,{useState} from 'react';
import {Wallet} from 'lucide-react';
// No hay registro público: las cuentas las habilita quien administra la app.
export function LoginView({onSubmit,notice}:{onSubmit:(email:string,password:string)=>Promise<string|null>;notice:string|null}){
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy)return;setBusy(true);setError(null);
  try{setError(await onSubmit(email.trim(),password));}finally{setBusy(false);}
 }
 const input='h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm';
 return <form onSubmit={submit} className="bg-white rounded-3xl p-8 max-w-sm w-full space-y-5">
  <div className="flex items-center gap-3">
   <span className="w-10 h-10 rounded-xl bg-accent text-white grid place-items-center"><Wallet className="w-5 h-5" aria-hidden="true"/></span>
   <h1 className="text-xl font-bold tracking-tight">Ingresá a GastosFamilia</h1>
  </div>
  {(error||notice)&&<p role="alert" className="text-sm text-red-700">{error||notice}</p>}
  <fieldset disabled={busy} className="space-y-4">
   <label className="block text-sm font-medium">Email
    <input aria-label="Email" type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} className={input+' mt-1'}/>
   </label>
   <label className="block text-sm font-medium">Contraseña
    <input aria-label="Contraseña" type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className={input+' mt-1'}/>
   </label>
   <button type="submit" className="h-11 w-full rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-60">{busy?'Ingresando…':'Ingresar'}</button>
  </fieldset>
  <p className="text-xs text-slate-500">¿No tenés cuenta? Pedile acceso a quien administra la app.</p>
 </form>;
}
