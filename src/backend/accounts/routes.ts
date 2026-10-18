import type {Express,Request,Response,NextFunction} from 'express';
import type {Pool} from 'pg';
import {transaction} from '../expenses/repository';
import {ApiError} from '../shared/errors';
import {normalizePhone} from '../whatsapp/security';
import {createLinkCode,openLinkCode,unlinkPhone} from './linking';
import {sessionMember,type SupabaseConfig} from './session';
// Debe registrarse antes de registerDatabaseApi, que cierra /api con un 404.
export function registerAccounts(app:Express,pool:Pool|null,config:SupabaseConfig|null){
 // Pública: la pantalla de acceso la necesita antes de tener sesión. La anon key de Supabase es pública por diseño.
 app.get('/api/auth/config',(_req,res)=>{
  res.json(config?{mode:'session',supabaseUrl:config.url,supabaseAnonKey:config.anonKey}:{mode:'basic'});
 });
 if(!config)return;
 const route=(handler:(req:Request,res:Response,db:Pool)=>Promise<unknown>)=>async(req:Request,res:Response,next:NextFunction)=>{
  try{
   if(!pool)throw new ApiError(503,'Configura DATABASE_URL para usar PostgreSQL.');
   await handler(req,res,pool);
  }catch(error){next(error);}
 };
 const profile=async(db:Pool,id:string,email:string|null)=>{
  const row=(await db.query('SELECT id,name,phone_number FROM appgastos.family_members WHERE id=$1',[id])).rows[0];
  return {id:row.id as string,name:row.name as string,email,phoneNumber:normalizePhone(row.phone_number),pendingLink:await openLinkCode(db,id)};
 };
 app.get('/api/auth/me',route(async(_req,res,db)=>{
  const me=sessionMember(res)!;
  res.json({member:await profile(db,me.id,me.email)});
 }));
 app.post('/api/auth/whatsapp-link',route(async(_req,res,db)=>{
  const me=sessionMember(res)!;
  if(me.phoneNumber)throw new ApiError(409,'Ya tenés un WhatsApp vinculado. Desvinculalo antes de vincular otro.');
  res.status(201).json(await transaction(db,tx=>createLinkCode(tx,me.familyId,me.id)));
 }));
 app.delete('/api/auth/whatsapp-link',route(async(_req,res,db)=>{
  const me=sessionMember(res)!;
  await transaction(db,tx=>unlinkPhone(tx,me.familyId,me.id));
  res.sendStatus(204);
 }));
}
