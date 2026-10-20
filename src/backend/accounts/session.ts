import {createHash} from 'node:crypto';
import type {RequestHandler} from 'express';
import type {Pool} from 'pg';
import {resolveFamilyId} from '../expenses/service';
import {ApiError} from '../shared/errors';
import {normalizePhone} from '../whatsapp/security';
import type {Role} from './policy';
export interface SupabaseConfig {url:string;anonKey:string}
// Integrante autenticado, resuelto en el servidor: nunca se toma de datos enviados por el cliente.
export interface SessionMember {id:string;name:string;familyId:string;authUserId:string;email:string|null;phoneNumber:string|null;role:Role}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sin SUPABASE_URL ni SUPABASE_ANON_KEY el servidor sigue con Basic Auth.
export function supabaseFromEnv(env=process.env):SupabaseConfig|null{
 const url=env.SUPABASE_URL?.trim(),anonKey=env.SUPABASE_ANON_KEY?.trim();
 if(!url&&!anonKey)return null;
 if(!url||!anonKey)throw new Error('Configura SUPABASE_URL y SUPABASE_ANON_KEY juntas.');
 let parsed:URL;
 try{parsed=new URL(url);}catch{throw new Error('SUPABASE_URL inválida.');}
 if(parsed.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(parsed.hostname))throw new Error('SUPABASE_URL debe usar https.');
 return {url:url.replace(/\/+$/,''),anonKey};
}
// shortcut: caché en memoria de 30 s; una sesión revocada puede seguir valiendo ese tiempo. Sin caché, una consulta a Supabase por request.
const CACHE_MS=30000,CACHE_MAX=500;
const cache=new Map<string,{until:number;user:{id:string;email:string|null}}>();
// Supabase valida firma, vencimiento y revocación. La anon key sola no tiene `sub`, así que nunca identifica a nadie.
export async function verifyToken(config:SupabaseConfig,token:string,fetchImpl:typeof fetch=fetch){
 const key=createHash('sha256').update(token).digest('hex'),hit=cache.get(key);
 if(hit&&hit.until>Date.now())return hit.user;
 let res:Response;
 try{res=await fetchImpl(config.url+'/auth/v1/user',{headers:{apikey:config.anonKey,Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});}
 catch{throw new ApiError(503,'No se pudo validar la sesión. Reintentá en unos segundos.');}
 if(res.status===401||res.status===403)return null;
 if(!res.ok)throw new ApiError(503,'No se pudo validar la sesión. Reintentá en unos segundos.');
 const body:any=await res.json().catch(()=>null);
 if(typeof body?.id!=='string'||!UUID.test(body.id))return null;
 const user={id:body.id.toLowerCase(),email:typeof body.email==='string'?body.email:null};
 if(cache.size>=CACHE_MAX)for(const [k,v] of cache)if(v.until<=Date.now())cache.delete(k);
 if(cache.size<CACHE_MAX)cache.set(key,{until:Date.now()+CACHE_MS,user});
 return user;
}
export const clearSessionCache=()=>cache.clear();
// Quedan fuera: el webhook de Meta (valida su firma) y la configuración pública que necesita la pantalla de acceso.
const PUBLIC_PATHS=['/api/whatsapp/webhook','/api/auth/config'];
export function sessionAuth(pool:Pool|null,config:SupabaseConfig,fetchImpl:typeof fetch=fetch):RequestHandler{
 return async(req,res,next)=>{
  res.app.locals.requireSession=true;
  if(!req.path.startsWith('/api')||PUBLIC_PATHS.includes(req.path))return next();
  try{
   const header=req.get('Authorization')||'';
   const token=header.startsWith('Bearer ')?header.slice(7).trim():'';
   if(!token||token.length>4096)return void res.status(401).json({error:'Iniciá sesión para continuar.'});
   const user=await verifyToken(config,token,fetchImpl);
   if(!user)return void res.status(401).json({error:'La sesión no es válida o venció. Volvé a iniciar sesión.'});
   if(!pool)throw new ApiError(503,'Configura DATABASE_URL para usar PostgreSQL.');
   const familyId=await resolveFamilyId(pool);
   const row=(await pool.query('SELECT id,name,phone_number,role FROM appgastos.family_members WHERE auth_user_id=$1 AND family_id=$2 AND active',[user.id,familyId])).rows[0];
   // Misma respuesta para "sin integrante" e "inactivo": no revela el estado de la familia.
   if(!row)return void res.status(403).json({error:'Tu cuenta no está habilitada para esta familia. Pedile acceso a quien administra la app.'});
   const member:SessionMember={id:row.id,name:row.name,familyId,authUserId:user.id,email:user.email,phoneNumber:normalizePhone(row.phone_number),role:row.role};
   res.locals.member=member;
   next();
  }catch(error){next(error);}
 };
}
export const sessionMember=(res:{locals:Record<string,any>}):SessionMember|undefined=>res.locals.member;
