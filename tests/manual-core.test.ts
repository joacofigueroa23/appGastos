
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './helpers/postgres';
import {migrate} from '../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../scripts/seed';
import {registerDatabaseApi} from '../src/backend/expenses/routes';

test('Núcleo manual: catálogos, CRUD completo, filtros e integridad histórica',{timeout:90000},async(t)=>{
 const db=await isolatedDatabase();let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await migrate(db.pool);await seed(db.pool);
  const app=express();app.use(express.json());registerDatabaseApi(app,db.pool,INITIAL_FAMILY_ID);
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const request=async(path:string,method='GET',body?:unknown)=>{
   const response=await fetch(origin+'/api/'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,body:response.status===204?null:await response.json()};
  };
  const cardResult=await request('cards','POST',{name:'Visa'});assert.equal(cardResult.status,201);const card=cardResult.body.card;
  const memberResult=await request('family-members','POST',{name:'Ana',phoneNumber:null});assert.equal(memberResult.status,201);const member=memberResult.body.member;
  const categories=(await request('categories')).body.categories;
  const category=categories.find((c:any)=>c.name==='Supermercado'),otherCategory=categories.find((c:any)=>c.name==='Mascotas');
  const input={date:'2026-10-08',amount:'40000.00',currency:'ARS',merchant:'Carrefour',description:'Compra inicial',categoryId:category.id,paymentMethod:'credit_card',cardId:card.id,reportedByMemberId:member.id};
  const created=await request('expenses','POST',input);assert.equal(created.status,201);let expense=created.body.expense;
  await t.test('crear y editar catálogos; nullable phone y reactivación',async()=>{
   assert.equal((await request('cards')).body.cards.length,1);
   assert.equal((await request('family-members')).body.members.length,1);
   const cardEdit=await request('cards/'+card.id,'PATCH',{name:'Visa familia'});assert.equal(cardEdit.status,200);assert.equal(cardEdit.body.card.name,'Visa familia');
   const memberEdit=await request('family-members/'+member.id,'PATCH',{name:'Ana familia',phoneNumber:'+54 11 4444 5555'});assert.equal(memberEdit.status,200);
   assert.equal(memberEdit.body.member.phoneNumber,'+54 11 4444 5555');
   assert.equal((await request('family-members/'+member.id,'PATCH',{phoneNumber:null})).body.member.phoneNumber,null);
   assert.equal((await request('family-members/'+member.id,'PATCH',{active:false})).status,200);
   assert.equal((await request('family-members/'+member.id,'PATCH',{active:true})).body.member.active,true);
   assert.equal((await request('cards/'+card.id,'PATCH',{active:false})).status,200);
   assert.equal((await request('cards/'+card.id,'PATCH',{active:true})).body.card.active,true);
  });
  await t.test('validación de miembros/tarjetas y cambios desconocidos',async()=>{
   for(const body of [{name:''},{name:'x',phoneNumber:12},{name:'x',active:'true'},{name:'x',familyId:randomUUID()},{name:'x',phoneNumber:'x'.repeat(41)}])
    assert.equal((await request('family-members','POST',body)).status,400);
   assert.equal((await request('cards','POST',{name:'Visa familia'})).status,409);
   assert.equal((await request('cards/'+card.id,'PATCH',{})).status,400);
   assert.equal((await request('family-members/'+member.id,'PATCH',{bank:'Banco'})).status,400);
   assert.equal((await request('family-members/'+randomUUID(),'PATCH',{name:'No existe'})).status,404);
  });
  await t.test('tipo de tarjeta: alta, edición y coherencia con el medio de pago',async()=>{
   assert.equal(card.cardType,null);
   for(const cardType of ['credito','cash',1])assert.equal((await request('cards','POST',{name:'Tipo inválido',cardType})).status,400);
   const typed=await request('cards','POST',{name:'Naranja',cardType:'credit_card'});assert.equal(typed.status,201);assert.equal(typed.body.card.cardType,'credit_card');
   assert.equal((await request('expenses','POST',{...input,description:'Tipo incoherente',paymentMethod:'debit_card',cardId:typed.body.card.id})).status,400);
   const ok=await request('expenses','POST',{...input,description:'Tipo coherente',cardId:typed.body.card.id});assert.equal(ok.status,201);
   // Cambiar el tipo luego no impide editar el gasto histórico sin tocar tarjeta ni medio.
   assert.equal((await request('cards/'+typed.body.card.id,'PATCH',{cardType:'debit_card'})).body.card.cardType,'debit_card');
   assert.equal((await request('expenses/'+ok.body.expense.id,'PATCH',{description:'Histórico editado'})).status,200);
   assert.equal((await request('expenses/'+ok.body.expense.id,'PATCH',{paymentMethod:'credit_card',cardId:typed.body.card.id,amount:'1'})).status,200);
   assert.equal((await request('cards/'+typed.body.card.id,'PATCH',{cardType:null})).body.card.cardType,null);
   assert.equal((await request('expenses/'+ok.body.expense.id,'DELETE')).status,204);
   assert.equal((await request('cards/'+typed.body.card.id,'PATCH',{active:false})).status,200);
  });
  const alternateCard=(await request('cards','POST',{name:'Débito'})).body.card;
  const alternateMember=(await request('family-members','POST',{name:'Luis',phoneNumber:'11 5555 6666'})).body.member;
  await t.test('editar todos los campos del gasto y recuperar la versión persistida',async()=>{
   const edit={date:'2026-09-11',amount:'1234.56',currency:'USD',merchant:'Otro comercio',description:'Compra editada',categoryId:otherCategory.id,paymentMethod:'debit_card',cardId:alternateCard.id,reportedByMemberId:alternateMember.id};
   const result=await request('expenses/'+expense.id,'PATCH',edit);assert.equal(result.status,200);expense=result.body.expense;
   for(const [key,value] of Object.entries(edit))assert.equal(expense[key],value,key);
   assert.equal(expense.source,'manual');
   assert.notEqual(expense.updatedAt,expense.createdAt);
   const recovered=(await request('expenses/'+expense.id)).body.expense;
   assert.equal(recovered.amount,'1234.56');assert.equal(recovered.date,'2026-09-11');
  });
  await request('expenses','POST',{...input,description:'Control sin referencias',cardId:null,reportedByMemberId:null});
  await request('expenses','POST',{...input,description:'Control otra moneda',currency:'USD'});
  await request('expenses','POST',{...input,description:'Control efectivo',paymentMethod:'cash',cardId:null,reportedByMemberId:null,merchant:'Kiosco'});
  await t.test('filtros por mes, categoría, medio, tarjeta, integrante y comercio',async()=>{
   const filtered=async(filters:Record<string,string>)=>{
    const result=await request('expenses?'+new URLSearchParams(filters));assert.equal(result.status,200);return result.body.expenses;
   };
   assert.equal((await filtered({month:'2026-09'})).length,1);
   assert.equal((await filtered({categoryId:otherCategory.id}))[0].id,expense.id);
   assert.equal((await filtered({paymentMethod:'debit_card'}))[0].id,expense.id);
   assert.equal((await filtered({cardId:alternateCard.id}))[0].id,expense.id);
   assert.equal((await filtered({reportedByMemberId:alternateMember.id}))[0].id,expense.id);
   assert.equal((await filtered({merchant:'oTrO CoMeRcIo'}))[0].id,expense.id);
   assert.equal((await filtered({merchant:'%'})).length,0);
   const combined=await filtered({month:'2026-09',currency:'USD',categoryId:otherCategory.id,paymentMethod:'debit_card',cardId:alternateCard.id,reportedByMemberId:alternateMember.id,merchant:'Otro'});
   assert.equal(combined.length,1);assert.equal(combined[0].amount,'1234.56');
   assert.equal((await filtered({month:'2026-09',currency:'ARS'})).length,0);
   const invalidFilters:Record<string,string>[]=[{paymentMethod:'inventado'},{categoryId:'no-uuid'},{month:'0000-01'},{month:'2026-13'},{cardId:'1'},{merchant:' '}];
   for(const filters of invalidFilters)
    assert.equal((await request('expenses?'+new URLSearchParams(filters))).status,400);
  });
  await t.test('inactivos rechazados en creaciones/cambios; historia y filtros intactos',async()=>{
   await request('cards/'+alternateCard.id,'PATCH',{active:false});
   await request('family-members/'+alternateMember.id,'PATCH',{active:false});
   assert.equal((await request('expenses','POST',{...input,cardId:alternateCard.id,reportedByMemberId:null})).status,400);
   assert.equal((await request('expenses','POST',{...input,cardId:null,reportedByMemberId:alternateMember.id})).status,400);
   assert.equal((await request('expenses/'+expense.id,'PATCH',{description:'Historia intacta'})).status,200);
   const history=(await request('expenses/'+expense.id)).body.expense;assert.equal(history.cardId,alternateCard.id);assert.equal(history.reportedByMemberId,alternateMember.id);
   assert.equal((await request('expenses?cardId='+alternateCard.id)).body.expenses.length,1);
   assert.equal((await request('expenses?reportedByMemberId='+alternateMember.id)).body.expenses.length,1);
   await assert.rejects(db.pool.query('DELETE FROM appgastos.family_members WHERE id=$1',[alternateMember.id]),(e:any)=>e.code==='23503');
   const otherExpense=(await request('expenses')).body.expenses.find((e:any)=>e.id!==expense.id);
   assert.equal((await request('expenses/'+otherExpense.id,'PATCH',{cardId:alternateCard.id,paymentMethod:'credit_card'})).status,400);
   assert.equal((await request('expenses/'+otherExpense.id,'PATCH',{reportedByMemberId:alternateMember.id})).status,400);
  });
  await t.test('aislamiento familiar de catálogos',async()=>{
   const family=randomUUID();await db.pool.query('INSERT INTO appgastos.families(id,name) VALUES($1,$2)',[family,'Otra']);
   const alien=(await db.pool.query('INSERT INTO appgastos.family_members(family_id,name) VALUES($1,$2) RETURNING id',[family,'Ajeno'])).rows[0].id;
   assert.equal((await request('family-members/'+alien,'PATCH',{name:'No permitido'})).status,404);
   assert.equal((await request('expenses','POST',{...input,reportedByMemberId:alien})).status,400);
  });
  await t.test('eliminar sin afectar catálogos ni gastos restantes',async()=>{
   const before=(await request('expenses')).body.expenses.length;
   assert.equal((await request('expenses/'+expense.id,'DELETE')).status,204);
   assert.equal((await request('expenses')).body.expenses.length,before-1);
   assert.equal((await request('expenses/'+expense.id)).status,404);
   assert.equal((await request('cards')).body.cards.length,3);
   assert.equal((await request('family-members')).body.members.length,2);
  });
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await db.stop();}
});
