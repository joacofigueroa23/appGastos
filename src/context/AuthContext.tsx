import React,{createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';
import {ApiRequestError,configureSession,financeApi} from '../services/financeApi';
import type {AuthMember} from '../shared/apiTypes';
import {LoginView} from '../components/LoginView';
// mode 'basic': el navegador autentica con Basic Auth, no hay perfil. mode 'session': sesión individual de Supabase.
interface AuthState {mode:'basic'|'session';member:AuthMember|null;signOut:()=>Promise<void>;refreshMe:()=>Promise<AuthMember|null>}
const AuthContext=createContext<AuthState>({mode:'basic',member:null,signOut:async()=>{},refreshMe:async()=>null});
export const useAuth=()=>useContext(AuthContext);
type Phase='loading'|'login'|'denied'|'ready';
const Screen=({children}:{children:ReactNode})=><div className="min-h-screen bg-ground flex items-center justify-center p-4">{children}</div>;
export function AuthGate({children}:{children:ReactNode}){
 const [phase,setPhase]=useState<Phase>('loading'),[mode,setMode]=useState<'basic'|'session'>('basic');
 const [member,setMember]=useState<AuthMember|null>(null),[notice,setNotice]=useState<string|null>(null),[deniedMessage,setDeniedMessage]=useState('');
 const client=useRef<SupabaseClient|null>(null);
 const refreshMe=useCallback(async()=>{
  try{const {member:me}=await financeApi.me();setMember(me);setPhase('ready');return me;}
  catch(error){
   if(error instanceof ApiRequestError&&error.status===403){setDeniedMessage(error.message);setPhase('denied');}
   else if(!(error instanceof ApiRequestError&&error.status===401)){setNotice('No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.');setPhase('login');}
   return null;
  }
 },[]);
 const signOut=useCallback(async(message:string|null=null)=>{
  await client.current?.auth.signOut().catch(()=>{});
  setMember(null);setNotice(message);setPhase('login');
 },[]);
 useEffect(()=>{
  let cancelled=false;
  (async()=>{
   let config:any=null;
   try{const res=await fetch('/api/auth/config');if(res.ok&&res.headers.get('content-type')?.includes('application/json'))config=await res.json();}catch{}
   if(cancelled)return;
   if(config?.mode!=='session'){setPhase('ready');return;}
   const {createClient}=await import('@supabase/supabase-js');
   if(cancelled)return;
   const supabase=createClient(config.supabaseUrl,config.supabaseAnonKey);client.current=supabase;
   configureSession(async()=>(await supabase.auth.getSession()).data.session?.access_token??null,()=>{void signOut('Tu sesión venció. Iniciá sesión de nuevo.');});
   setMode('session');
   if((await supabase.auth.getSession()).data.session)await refreshMe();else if(!cancelled)setPhase('login');
  })();
  return ()=>{cancelled=true;};
 },[refreshMe,signOut]);
 async function signIn(email:string,password:string):Promise<string|null>{
  const {error}=await client.current!.auth.signInWithPassword({email,password});
  if(error)return /invalid login|invalid credentials/i.test(error.message)?'Email o contraseña incorrectos.':'No pudimos iniciar sesión. Intentá de nuevo en unos minutos.';
  setNotice(null);await refreshMe();return null;
 }
 if(phase==='loading')return <Screen><p role="status" className="text-sm text-slate-500">Cargando…</p></Screen>;
 if(phase==='login')return <Screen><LoginView onSubmit={signIn} notice={notice}/></Screen>;
 if(phase==='denied')return <Screen><div role="alert" className="bg-white rounded-3xl p-8 max-w-md w-full space-y-4">
  <h1 className="text-xl font-bold">Tu cuenta todavía no tiene acceso</h1>
  <p className="text-sm text-slate-600">{deniedMessage}</p>
  <button onClick={()=>void signOut()} className="h-10 px-4 rounded-xl bg-accent text-white text-sm font-semibold">Cerrar sesión</button>
 </div></Screen>;
 return <AuthContext.Provider value={{mode,member,signOut:()=>signOut(),refreshMe}}>{children}</AuthContext.Provider>;
}
