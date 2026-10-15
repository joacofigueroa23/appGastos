
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './helpers/postgres';
import {migrate} from '../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../scripts/seed';
import {registerDatabaseApi} from '../src/backend/expenses/routes';
import {createDatabasePool} from '../src/backend/db/pool';
import {sumAmounts} from '../src/utils/finance';
test('API y restricciones sobre PostgreSQL temporal real',{timeout:90000},async(t)=>{
 const db=await isolatedDatabase();let server:any;
 try{
  for(const script of ['scripts/migrate.ts','scripts/seed.ts']) {
   const result=spawnSync(process.execPath,['--import','tsx',script],{windowsHide:true,encoding:'utf8',env:{...process.env,DATABASE_URL:db.url,APP_FAMILY_ID:INITIAL_FAMILY_ID,SEED_MEMBER_NAME:''}});
   assert.equal(result.status,0,result.stderr);
  }
  await migrate(db.pool);await migrate(db.pool);await seed(db.pool,INITIAL_FAMILY_ID,'Prueba');await seed(db.pool,INITIAL_FAMILY_ID,'Prueba');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.schema_migrations')).rows[0].n,readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).length);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.cards')).rows[0].n,0);
  const app=express();app.use(express.json());registerDatabaseApi(app,db.pool,INITIAL_FAMILY_ID);
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(path:string,method='GET',body?:unknown)=>{
   const r=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,data:r.status===204?null:await r.json()};
  };
  const category=(await request('categories')).data.categories.find((c:any)=>c.name==='Supermercado');assert.ok(category);
  const member=(await request('family-members')).data.members[0];assert.ok(member);
  const cardResult=await request('cards','POST',{name:'Visa'});assert.equal(cardResult.status,201);const card=cardResult.data.card;
  const input={date:'2026-10-08',amount:'40000',currency:'ARS',merchant:'Carrefour',description:'Compra familiar',categoryId:category.id,paymentMethod:'credit_card',cardId:card.id,reportedByMemberId:member.id};
  const created=await request('expenses','POST',input);assert.equal(created.status,201);let expense=created.data.expense;
  await t.test('crear, listar, recuperar, source e integrante',async()=>{
   assert.equal(expense.amount,'40000.00');assert.equal(expense.date,'2026-10-08');assert.equal(expense.source,'manual');
   assert.equal(expense.cardId,card.id);assert.equal(expense.reportedByMemberId,member.id);assert.equal(expense.merchant,'Carrefour');
   assert.equal((await request('expenses/'+expense.id)).data.expense.id,expense.id);assert.equal((await request('expenses')).data.expenses.length,1);
  });
  await t.test('decimal, fecha literal, PATCH y consulta desde otra conexi?n',async()=>{
   const edited=await request('expenses/'+expense.id,'PATCH',{amount:'1234.56'});assert.equal(edited.status,200);expense=edited.data.expense;
   assert.equal(expense.amount,'1234.56');assert.equal(expense.date,'2026-10-08');assert.equal(expense.cardId,card.id);
   const second=createDatabasePool(db.url);
   try{const row=(await second.query("SELECT amount::text,date::text FROM appgastos.expenses WHERE id=$1",[expense.id])).rows[0];assert.equal(row.amount,'1234.56');assert.equal(row.date,'2026-10-08');}finally{await second.end();}
  });
  await t.test('referencias, fecha, monto, moneda, medio y campos inv?lidos',async()=>{
   for(const changes of [{categoryId:randomUUID()},{cardId:randomUUID()},{reportedByMemberId:randomUUID()},{amount:'0'},{amount:'-1'},{amount:'1.234'},{amount:'1234567890123'},{date:'2026-02-30'},{paymentMethod:'inventado'},{paymentMethod:'cash'},{currency:'ars'},{source:'whatsapp'},{familyId:randomUUID()},{categoryId:null},{description:''}])
    assert.equal((await request('expenses','POST',{...input,...changes})).status,400,JSON.stringify(changes));
   assert.equal((await request('expenses/no-uuid')).status,400);assert.equal((await request('expenses/'+randomUUID())).status,404);
   assert.equal((await request('expenses/'+expense.id,'PATCH',{})).status,400);
  });
  await t.test('tarjeta nullable sin arbitrariedad; m?tricas de un mes y moneda',async()=>{
   const noCard=await request('expenses','POST',{...input,amount:'25.25',cardId:null,reportedByMemberId:null});assert.equal(noCard.status,201);
   assert.equal(noCard.data.expense.cardId,null);assert.equal(noCard.data.expense.reportedByMemberId,null);
   assert.equal((await request('expenses','POST',{...input,currency:'USD',amount:'100'})).status,201);
   assert.equal((await request('expenses','POST',{...input,date:'2026-09-08',amount:'9000'})).status,201);
   const ars=(await request('expenses?month=2026-10&currency=ARS')).data.expenses;assert.equal(ars.length,2);
   assert.equal(sumAmounts(ars.map((e:any)=>({amount:Number(e.amount)}))),1259.81);
   assert.equal((await request('expenses?month=2026-10&currency=USD')).data.expenses.length,1);
   assert.equal((await request('expenses?month=2026-13')).status,400);
  });
  await t.test('inactivos hist?ricos y claves for?neas sin cascadas',async()=>{
   assert.equal((await request('cards/'+card.id,'PATCH',{active:false})).status,200);
   assert.equal((await request('expenses','POST',input)).status,400);
   assert.equal((await request('expenses/'+expense.id,'PATCH',{description:'Historia'})).status,200);
   await assert.rejects(db.pool.query('DELETE FROM appgastos.cards WHERE id=$1',[card.id]),(e:any)=>e.code==='23503');
   await assert.rejects(db.pool.query('DELETE FROM appgastos.categories WHERE id=$1',[category.id]),(e:any)=>e.code==='23503');
   await db.pool.query('UPDATE appgastos.categories SET active=false WHERE id=$1',[category.id]);
   assert.equal((await request('expenses','POST',{...input,cardId:null})).status,400);
   assert.equal((await request('expenses/'+expense.id,'PATCH',{description:'Categor?a hist?rica'})).status,200);
  });
  await t.test('aislamiento familiar y protecci?n SQL',async()=>{
   const family=randomUUID();await db.pool.query('INSERT INTO appgastos.families(id,name) VALUES($1,$2)',[family,'Otra']);
   const foreign=(await db.pool.query('INSERT INTO appgastos.categories(family_id,name) VALUES($1,$2) RETURNING id',[family,'Ajena'])).rows[0].id;
   assert.equal((await request('expenses','POST',{...input,cardId:null,categoryId:foreign})).status,400);
   await assert.rejects(db.pool.query('UPDATE appgastos.expenses SET category_id=$1 WHERE id=$2',[foreign,expense.id]),(e:any)=>e.code==='23503');
   await assert.rejects(db.pool.query('UPDATE appgastos.expenses SET amount=0 WHERE id=$1',[expense.id]),(e:any)=>e.code==='23514');
  });
  await t.test('eliminar y nueva consulta',async()=>{
   assert.equal((await request('expenses/'+expense.id,'DELETE')).status,204);
   assert.equal((await request('expenses/'+expense.id)).status,404);assert.equal((await request('expenses/'+expense.id,'DELETE')).status,404);
   assert.ok(!(await request('expenses')).data.expenses.some((e:any)=>e.id===expense.id));
  });
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));await db.stop();}
});
