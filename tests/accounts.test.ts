import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import express from 'express';
import {isolatedDatabase} from './helpers/postgres';
import {migrate} from '../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../scripts/seed';
import {memberAccount} from '../scripts/member-account';
import {authFromEnv} from '../src/backend/auth';
import {sessionAuth,supabaseFromEnv,clearSessionCache} from '../src/backend/accounts/session';
import {registerAccounts} from '../src/backend/accounts/routes';
import {parseLinkCommand} from '../src/backend/accounts/linking';
import {registerWhatsApp} from '../src/backend/whatsapp/routes';
import {registerDatabaseApi} from '../src/backend/expenses/routes';
import {enqueue} from '../src/backend/whatsapp/repository';
import {whatsappProcessor} from '../src/backend/whatsapp/processor';

const ANON_KEY='anon-public-key';
const users={ana:randomUUID(),beto:randomUUID(),luis:randomUUID(),ghost:randomUUID()};
// Supabase simulado: solo reconoce estos tokens de usuario; la anon key y cualquier otro valor dan 401.
const tokens:Record<string,string>={'tok-ana':users.ana,'tok-beto':users.beto,'tok-luis':users.luis,'tok-ghost':users.ghost};
async function fakeSupabase(){
 let calls=0;
 const server=createServer((req,res)=>{
  calls++;
  const token=(req.headers.authorization||'').replace('Bearer ','');
  if(req.url==='/auth/v1/user'&&req.headers.apikey===ANON_KEY&&tokens[token])return void res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({id:tokens[token],email:token+'@familia.test'}));
  res.writeHead(401,{'Content-Type':'application/json'}).end('{"msg":"invalid JWT"}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+(server.address() as any).port,server,calls:()=>calls};
}
const listen=async(server:Server)=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+(server.address() as any).port;};

test('Cuentas individuales: sesión, autoría, vinculación de WhatsApp y permisos',async(t)=>{
 const db=await isolatedDatabase(),supa=await fakeSupabase();
 await migrate(db.pool);await seed(db.pool);
 const q=(sql:string,args:unknown[]=[])=>db.pool.query(sql,args);
 const member=async(name:string,auth:string|null,active=true,phone:string|null=null)=>(await q('INSERT INTO appgastos.family_members(family_id,name,auth_user_id,active,phone_number) VALUES($1,$2,$3,$4,$5) RETURNING id',[INITIAL_FAMILY_ID,name,auth,active,phone])).rows[0].id as string;
 const ana=await member('Ana',users.ana),beto=await member('Beto',users.beto),luis=await member('Luis',users.luis,false),carla=await member('Carla',null,true,'5491100000003');
 const category=(await q("INSERT INTO appgastos.categories(family_id,name) VALUES($1,'Compras') RETURNING id",[INITIAL_FAMILY_ID])).rows[0].id as string;
 const historic=(await q("INSERT INTO appgastos.expenses(family_id,date,amount,currency,description,category_id,payment_method) VALUES($1,'2026-09-01',500,'ARS','Gasto histórico',$2,'cash') RETURNING id",[INITIAL_FAMILY_ID,category])).rows[0].id as string;
 const replies:{to:string;text:string}[]=[];
 const interpret=async()=>({amount:'1000',amountText:'1000',dateText:null,currency:null,currencyText:null,merchant:'Kiosco',description:'Compra en kiosco',category:'Compras',paymentMethod:'cash' as const,paymentMethodText:'efectivo',card:null});
 const processor=whatsappProcessor(db.pool,interpret,async(to,text)=>{replies.push({to,text});});
 const app=express();
 app.use(sessionAuth(db.pool,{url:supa.url,anonKey:ANON_KEY}));
 registerWhatsApp(app,db.pool,{secret:'s',phoneNumberId:'1',startWorker:false,send:async()=>{}});
 app.use(express.json());registerAccounts(app,db.pool,{url:supa.url,anonKey:ANON_KEY});registerDatabaseApi(app,db.pool);
 const server=createServer(app),base=await listen(server);
 const call=(path:string,token?:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(res:Response)=>res.json() as Promise<any>;
 const incoming=async(id:string,text:string,from:string)=>{
  await enqueue(db.pool,INITIAL_FAMILY_ID,[{id,sender:from,text,type:'text',receivedAt:new Date()}]);
  await processor.processNext();
  return (await q('SELECT * FROM appgastos.whatsapp_messages WHERE message_id=$1',[id])).rows[0];
 };
 t.after(async()=>{server.close();supa.server.close();await db.stop();});

 await t.test('sin sesión válida no hay acceso a /api',async()=>{
  for(const token of [undefined,'basura','tok-vencido',ANON_KEY])assert.equal((await call('/api/expenses',token)).status,401,String(token));
  assert.equal((await fetch(base+'/api/expenses',{headers:{Authorization:'Basic dTpw'}})).status,401);
  assert.equal((await call('/api/family-members')).status,401);
 });
 await t.test('cuenta válida sin integrante o con integrante inactivo: 403',async()=>{
  for(const token of ['tok-ghost','tok-luis']){
   const res=await call('/api/expenses',token);assert.equal(res.status,403);
   assert.match((await json(res)).error,/no está habilitada/);
  }
 });
 await t.test('la configuración pública se sirve sin sesión y el webhook conserva su validación de firma',async()=>{
  const config=await json(await call('/api/auth/config'));
  assert.deepEqual(config,{mode:'session',supabaseUrl:supa.url,supabaseAnonKey:ANON_KEY});
  assert.equal((await fetch(base+'/api/whatsapp/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status,403);
 });
 await t.test('Supabase caído: 503 y no 401',async()=>{
  clearSessionCache();const saved=supa.url;
  const dead=express();dead.use(sessionAuth(db.pool,{url:'http://127.0.0.1:9',anonKey:ANON_KEY}));registerDatabaseApi(dead,db.pool);
  const s=createServer(dead),url=await listen(s);
  try{assert.equal((await fetch(url+'/api/expenses',{headers:{Authorization:'Bearer tok-ana'}})).status,503);}finally{s.close();}
  assert.ok(saved);
 });
 await t.test('integrante activo lee los movimientos de toda la familia',async()=>{
  const a=await json(await call('/api/expenses','tok-ana'));assert.equal(a.expenses.length,1);
  const b=await json(await call('/api/expenses','tok-beto'));assert.deepEqual(b.expenses.map((e:any)=>e.id),[historic]);
  assert.equal(b.expenses[0].reportedByMemberId,null);
 });
 await t.test('autoría: la define el servidor y no se puede falsificar ni reasignar',async()=>{
  const body={date:'2026-10-10',amount:'35000',currency:'ARS',description:'Súper',categoryId:category,paymentMethod:'cash'};
  const created=await json(await call('/api/expenses','tok-ana','POST',body));
  assert.equal(created.expense.reportedByMemberId,ana);
  // Falsificar: indicar a otro integrante, o intentar elegir la familia.
  assert.equal((await call('/api/expenses','tok-ana','POST',{...body,reportedByMemberId:beto})).status,403);
  assert.equal((await call('/api/expenses','tok-ana','POST',{...body,familyId:randomUUID()})).status,400);
  // Otro integrante puede editar el monto (gasto compartido) pero el autor original se conserva.
  const edited=await json(await call('/api/expenses/'+created.expense.id,'tok-beto','PATCH',{amount:'36000'}));
  assert.equal(edited.expense.amount,'36000.00');assert.equal(edited.expense.reportedByMemberId,ana);
  assert.equal((await call('/api/expenses/'+created.expense.id,'tok-beto','PATCH',{reportedByMemberId:beto})).status,403);
  assert.equal((await call('/api/expenses/'+created.expense.id,'tok-ana','PATCH',{reportedByMemberId:null,amount:'1'})).status,200);
  assert.equal((await json(await call('/api/expenses/'+created.expense.id,'tok-ana'))).expense.reportedByMemberId,ana);
  // Histórico: sigue sin autor, no se asigna uno inventado.
  assert.equal((await call('/api/expenses/'+historic,'tok-ana','PATCH',{reportedByMemberId:ana})).status,403);
  assert.equal((await json(await call('/api/expenses/'+historic,'tok-ana','PATCH',{amount:'600'}))).expense.reportedByMemberId,null);
 });
 await t.test('filtro por integrante y totales familiares',async()=>{
  const mine=await json(await call('/api/expenses?reportedByMemberId='+ana,'tok-beto'));
  assert.ok(mine.expenses.length>=1&&mine.expenses.every((e:any)=>e.reportedByMemberId===ana));
  assert.equal((await json(await call('/api/expenses','tok-beto'))).expenses.length,2);
 });
 await t.test('una cuenta con acceso no se administra desde la API de otro integrante',async()=>{
  assert.equal((await call('/api/family-members/'+beto,'tok-ana','PATCH',{phoneNumber:'5491100009999'})).status,403);
  assert.equal((await call('/api/family-members/'+beto,'tok-ana','PATCH',{active:false})).status,403);
  assert.equal((await call('/api/family-members/'+ana,'tok-ana','PATCH',{phoneNumber:'5491100009999'})).status,403);
  assert.equal((await call('/api/family-members/'+beto,'tok-ana','PATCH',{name:'Beto M.'})).status,200);
  assert.equal((await call('/api/family-members/'+beto,'tok-ana','PATCH',{name:'Beto M.',active:true,phoneNumber:null})).status,200);
  // Un integrante sin cuenta (modo anterior) sigue administrándose como siempre.
  assert.equal((await call('/api/family-members/'+carla,'tok-ana','PATCH',{phoneNumber:'+54 9 11 0000 0003'})).status,200);
  const clash=await call('/api/family-members','tok-ana','POST',{name:'Doble',phoneNumber:'54-9-11-0000-0003'});
  assert.equal(clash.status,409);assert.match((await json(clash)).error,/número/);
  assert.equal((await json(await call('/api/family-members','tok-ana'))).members.find((m:any)=>m.id===ana).linked,true);
 });
 await t.test('vinculación: código de un solo uso enviado desde el número a vincular',async()=>{
  assert.equal(parseLinkCommand('  vincular abcd-2345 '),'ABCD2345');assert.equal(parseLinkCommand('Gasté 1000'),null);assert.equal(parseLinkCommand('vincular'),null);
  const link=await json(await call('/api/auth/whatsapp-link','tok-ana','POST'));
  assert.match(link.code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const stored=(await q('SELECT code_hash FROM appgastos.whatsapp_link_codes WHERE member_id=$1',[ana])).rows;
  assert.equal(stored.length,1);assert.ok(!JSON.stringify(stored).includes(link.code.replace('-','')));
  assert.ok((await json(await call('/api/auth/me','tok-ana'))).member.pendingLink);
  // Otro integrante (o un desconocido) no puede quedarse con el código con un mensaje de otro formato.
  assert.equal((await incoming('w-bad','vincular ZZZZ-ZZZZ','5491155550001')).outcome,'link_failed');
  const ok=await incoming('w-ok','vincular '+link.code.toLowerCase(),'5491155550001');
  assert.equal(ok.outcome,'linked');assert.equal(ok.text_body,null);
  assert.equal((await q('SELECT phone_number FROM appgastos.family_members WHERE id=$1',[ana])).rows[0].phone_number,'5491155550001');
  assert.equal((await json(await call('/api/auth/me','tok-ana'))).member.phoneNumber,'5491155550001');
  // Reutilizar el código, o intentar vincular otro número a una cuenta ya vinculada, falla.
  assert.equal((await incoming('w-reuse','vincular '+link.code,'5491155550002')).outcome,'link_failed');
  assert.equal((await call('/api/auth/whatsapp-link','tok-ana','POST')).status,409);
 });
 await t.test('un número ya vinculado a otra cuenta no puede vincularse a una segunda',async()=>{
  const link=await json(await call('/api/auth/whatsapp-link','tok-beto','POST'));
  const r=await incoming('w-taken','vincular '+link.code,'5491155550001');
  assert.equal(r.outcome,'link_failed');assert.match(r.reply_text,/ya está vinculado/);
  assert.equal((await q('SELECT phone_number FROM appgastos.family_members WHERE id=$1',[beto])).rows[0].phone_number,null);
  // El número de un integrante cargado a mano también cuenta como ocupado.
  assert.match((await incoming('w-taken2','vincular '+link.code,'5491100000003')).reply_text,/ya está vinculado/);
 });
 await t.test('código vencido, reintentos limitados y respuesta sin revelar el motivo',async()=>{
  const link=await json(await call('/api/auth/whatsapp-link','tok-beto','POST'));
  await q("UPDATE appgastos.whatsapp_link_codes SET expires_at=now()-interval '1 minute' WHERE member_id=$1",[beto]);
  const expired=await incoming('w-exp','vincular '+link.code,'5491166660001');
  assert.equal(expired.outcome,'link_failed');assert.match(expired.reply_text,/no es válido o venció/);
  for(let i=0;i<4;i++)await incoming('w-try'+i,'vincular AAAA-BBB'+i,'5491166660001');
  // Con 5 fallos en la hora el remitente queda bloqueado, incluso con un código bueno.
  const fresh=await json(await call('/api/auth/whatsapp-link','tok-beto','POST'));
  const locked=await incoming('w-locked','vincular '+fresh.code,'5491166660001');
  assert.match(locked.reply_text,/Demasiados intentos/);
  assert.equal((await q('SELECT phone_number FROM appgastos.family_members WHERE id=$1',[beto])).rows[0].phone_number,null);
  // Desde otro número el mismo código sirve: el bloqueo es por remitente.
  assert.equal((await incoming('w-beto','vincular '+fresh.code,'5491166660002')).outcome,'linked');
 });
 await t.test('mensajes del bot: autor según número vinculado; número desconocido no registra',async()=>{
  const before=(await q('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n;
  const r=await incoming('w-exp-1','Gasté 1000 en kiosco en efectivo','5491155550001');
  assert.equal(r.outcome,'registered');
  const e=(await q('SELECT reported_by_member_id,source FROM appgastos.expenses WHERE id=$1',[r.expense_id])).rows[0];
  assert.equal(e.reported_by_member_id,ana);assert.equal(e.source,'whatsapp');
  const b=await incoming('w-exp-2','Gasté 1000 en kiosco en efectivo','5491166660002');
  assert.equal((await q('SELECT reported_by_member_id FROM appgastos.expenses WHERE id=$1',[b.expense_id])).rows[0].reported_by_member_id,beto);
  const stranger=await incoming('w-exp-3','Gasté 1000 en kiosco en efectivo','5491177770000');
  assert.equal(stranger.outcome,'unauthorized');assert.equal(stranger.expense_id,null);assert.match(stranger.reply_text,/VINCULAR/);
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,before+2);
  // El mismo mensaje repetido por Meta no duplica el gasto ni cambia el autor.
  await enqueue(db.pool,INITIAL_FAMILY_ID,[{id:'w-exp-1',sender:'5491166660002',text:'Gasté 1000 en kiosco en efectivo',type:'text',receivedAt:new Date()}]);
  await processor.processNext();
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,before+2);
 });
 await t.test('desvincular quita el número y el bot deja de aceptarlo',async()=>{
  assert.equal((await call('/api/auth/whatsapp-link','tok-ana','DELETE')).status,204);
  assert.equal((await json(await call('/api/auth/me','tok-ana'))).member.phoneNumber,null);
  assert.equal((await incoming('w-after','Gasté 1000 en kiosco en efectivo','5491155550001')).outcome,'unauthorized');
 });
 await t.test('administración: vincular, retirar y desactivar cuentas por el administrador de la base',async()=>{
  const nueva=await member('Dani',null);
  assert.match(await memberAccount(db.pool,'link',nueva,randomUUID()),/Hecho/);
  await assert.rejects(memberAccount(db.pool,'link',nueva,randomUUID()),/ya tiene una cuenta/);
  await assert.rejects(memberAccount(db.pool,'link',carla,users.ana),/ya está vinculada/);
  assert.match(await memberAccount(db.pool,'list'),/Dani/);
  await memberAccount(db.pool,'deactivate',beto);clearSessionCache();
  assert.equal((await call('/api/expenses','tok-beto')).status,403);
  await memberAccount(db.pool,'activate',beto);clearSessionCache();
  assert.equal((await call('/api/expenses','tok-beto')).status,200);
  await memberAccount(db.pool,'unlink',beto);clearSessionCache();
  assert.equal((await call('/api/expenses','tok-beto')).status,403);
 });
 await t.test('migración aditiva: los datos históricos se conservan',async()=>{
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.expenses WHERE id=$1 AND reported_by_member_id IS NULL',[historic])).rows[0].n,1);
  const rls=(await q("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='appgastos' AND c.relkind='r' AND NOT c.relrowsecurity AND c.relname<>'schema_migrations'")).rows;
  assert.deepEqual(rls,[]);
 });
});

test('Configuración: Supabase y Basic Auth no se mezclan',()=>{
 assert.equal(supabaseFromEnv({}),null);
 assert.throws(()=>supabaseFromEnv({SUPABASE_URL:'https://x.supabase.co'}),/juntas/);
 assert.throws(()=>supabaseFromEnv({SUPABASE_URL:'http://x.supabase.co',SUPABASE_ANON_KEY:'k'}),/https/);
 assert.deepEqual(supabaseFromEnv({SUPABASE_URL:'https://x.supabase.co/',SUPABASE_ANON_KEY:'k'}),{url:'https://x.supabase.co',anonKey:'k'});
 // Con Supabase configurado no hace falta Basic Auth en producción; sin ninguno de los dos sigue sin arrancar.
 assert.equal(authFromEnv({NODE_ENV:'production',SUPABASE_URL:'https://x.supabase.co',SUPABASE_ANON_KEY:'k'}),null);
 assert.throws(()=>authFromEnv({NODE_ENV:'production'}),/APP_AUTH_USER/);
});
