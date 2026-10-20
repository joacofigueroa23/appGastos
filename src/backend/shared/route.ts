import type {NextFunction,Request,Response} from 'express';
import type {Pool} from 'pg';
import {actorOf,requireAdmin,type Actor} from '../accounts/policy';
import {resolveFamilyId} from '../expenses/service';
import {ApiError} from './errors';
// Handler de API con la familia y el actor ya resueltos en el servidor. adminOnly: exige rol administrador.
export const apiRoute=(pool:Pool|null,adminOnly=true)=>(handler:(req:Request,res:Response,db:Pool,family:string,actor:Actor)=>Promise<unknown>)=>
 async(req:Request,res:Response,next:NextFunction)=>{
  try{
   if(!pool)throw new ApiError(503,'Configura DATABASE_URL para usar PostgreSQL.');
   const actor=actorOf(res);
   if(adminOnly)requireAdmin(actor);
   await handler(req,res,pool,await resolveFamilyId(pool),actor);
  }catch(error){next(error);}
 };
// Mes "YYYY-MM" → primer día "YYYY-MM-01".
export function monthStart(value:unknown,field='month'):string{
 if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))throw new ApiError(400,field+' debe tener el formato YYYY-MM.');
 return value+'-01';
}
