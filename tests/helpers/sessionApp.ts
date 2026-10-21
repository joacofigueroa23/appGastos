// App completa con sesión individual contra una base temporal y un Supabase simulado (sin proyecto real).
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import express from 'express';
import {isolatedDatabase} from './postgres';
import {migrate} from '../../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../../scripts/seed';
import {sessionAuth,clearSessionCache} from '../../src/backend/accounts/session';
import {registerAccounts} from '../../src/backend/accounts/routes';
import {registerWhatsApp} from '../../src/backend/whatsapp/routes';
import {registerDatabaseApi} from '../../src/backend/expenses/routes';
import {registerBudgets} from '../../src/backend/budgets/routes';
import {registerFixedExpenses} from '../../src/backend/fixed/routes';
import {registerDocuments} from '../../src/backend/documents/routes';
import type {DocumentDeps} from '../../src/backend/documents/service';
import type {Extraction} from '../../src/backend/documents/types';
import {enqueue} from '../../src/backend/whatsapp/repository';
import {whatsappProcessor} from '../../src/backend/whatsapp/processor';
import type {Interpretation} from '../../src/backend/whatsapp/candidate';
export const ANON_KEY='anon-public-key';
export {INITIAL_FAMILY_ID};
const nothing:Interpretation={amount:null,amountText:null,dateText:null,currency:null,currencyText:null,merchant:null,description:null,category:null,paymentMethod:null,paymentMethodText:null,card:null};
export async function sessionApp(opts:{documents?:DocumentDeps}={}){
 const db=await isolatedDatabase();await migrate(db.pool);await seed(db.pool);
 const q=(sql:string,args:unknown[]=[])=>db.pool.query(sql,args);
 const tokens:Record<string,string>={};
 const supa=createServer((req,res)=>{
  const id=tokens[(req.headers.authorization||'').replace('Bearer ','')];
  if(req.url==='/auth/v1/user'&&req.headers.apikey===ANON_KEY&&id)return void res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({id,email:id+'@familia.test'}));
  res.writeHead(401,{'Content-Type':'application/json'}).end('{"msg":"invalid JWT"}');
 });
 await new Promise<void>(r=>supa.listen(0,'127.0.0.1',r));
 const supaUrl='http://127.0.0.1:'+(supa.address() as any).port;
 let interpretation:Interpretation=nothing;
 const replies:{to:string;text:string}[]=[];
 const processor=whatsappProcessor(db.pool,async()=>interpretation,async(to,text)=>{replies.push({to,text});},opts.documents);
 const app=express();
 app.use(sessionAuth(db.pool,{url:supaUrl,anonKey:ANON_KEY}));
 registerWhatsApp(app,db.pool,{secret:'s',phoneNumberId:'1',startWorker:false,send:async()=>{}});
 app.use(express.json());registerAccounts(app,db.pool,{url:supaUrl,anonKey:ANON_KEY});
 registerBudgets(app,db.pool);registerFixedExpenses(app,db.pool);registerDocuments(app,db.pool,opts.documents?.extract);registerDatabaseApi(app,db.pool);
 const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 const call=(path:string,token?:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(res:Response)=>res.json() as Promise<any>;
 // Integrante con cuenta: token 'tok-<nombre>'. role y phone opcionales.
 const account=async(name:string,opts:{role?:'admin'|'member';active?:boolean;phone?:string|null}={})=>{
  const auth=randomUUID(),token='tok-'+name;tokens[token]=auth;
  const id=(await q('INSERT INTO appgastos.family_members(family_id,name,auth_user_id,role,active,phone_number) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[INITIAL_FAMILY_ID,name,auth,opts.role??'member',opts.active??true,opts.phone??null])).rows[0].id as string;
  return {id,token,auth};
 };
 const category=async(name:string)=>(await q('INSERT INTO appgastos.categories(family_id,name) VALUES($1,$2) ON CONFLICT(family_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[INITIAL_FAMILY_ID,name])).rows[0].id as string;
 const expense=(token:string,categoryId:string,extra:Record<string,unknown>={})=>call('/api/expenses',token,'POST',{date:'2026-10-10',amount:'1000',currency:'ARS',description:'Gasto',categoryId,paymentMethod:'cash',...extra});
 // Mensaje de WhatsApp de un número; la interpretación (Gemini) se simula.
 const incoming=async(id:string,text:string,from:string,at=new Date())=>{
  await enqueue(db.pool,INITIAL_FAMILY_ID,[{id,sender:from,text,type:'text',receivedAt:at}]);
  await processor.processNext();await processor.replyNext();
  return (await q('SELECT * FROM appgastos.whatsapp_messages WHERE message_id=$1',[id])).rows[0];
 };
 return {db,q,call,json,account,category,expense,incoming,replies,processor,supa,tokens,base,
  interpret:(i:Partial<Interpretation>)=>{interpretation={...nothing,...i};},revoke:(token:string)=>{delete tokens[token];clearSessionCache();},
  async stop(){server.close();supa.close();await db.stop();}};
}
