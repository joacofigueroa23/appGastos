import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sessionApp,INITIAL_FAMILY_ID} from './helpers/sessionApp';

test('Presupuestos mensuales: permisos, unicidad, consumo y copia entre meses',async(t)=>{
 const app=await sessionApp();
 const {q,call,json}=app;
 t.after(()=>app.stop());
 const ana=await app.account('ana',{role:'admin'}),beto=await app.account('beto');
 const comida=await app.category('Alimentación'),salud=await app.category('Salud'),ocio=await app.category('Ocio');
 const put=(month:string,category:string,amount:unknown,token=ana.token)=>call('/api/budgets/'+month+'/'+category,token,'PUT',{amount});
 const report=async(month:string,token=ana.token)=>json(await call('/api/budgets?month='+month,token));
 const line=(r:any,category:string)=>r.budgets.find((b:any)=>b.categoryId===category);
 const spend=(token:string,category:string,date:string,amount:string,extra:Record<string,unknown>={})=>app.expense(token,category,{date,amount,...extra}).then(json);
 const expenseCount=async()=>(await q('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n;

 await t.test('solo administradores consultan o modifican presupuestos; el integrante no ve importes',async()=>{
  assert.equal((await put('2026-10',comida,'100000')).status,204);
  for(const [method,path,body] of [['GET','/api/budgets?month=2026-10',undefined],['PUT','/api/budgets/2026-10/'+comida,{amount:'1'}],['DELETE','/api/budgets/2026-10/'+comida,undefined],['POST','/api/budgets/copy',{from:'2026-10',to:'2026-11'}]] as const){
   const res=await call(path,beto.token,method,body);
   assert.equal(res.status,403,method+' '+path);
   assert.ok(!JSON.stringify(await res.json()).includes('100000'));
  }
  assert.equal((await call('/api/budgets?month=2026-10')).status,401);
  assert.equal(line(await report('2026-10'),comida).amount,'100000.00');
 });
 await t.test('validaciones: importe, mes y categoría',async()=>{
  for(const amount of ['0','-5','10.123','abc',null,undefined])assert.equal((await put('2026-10',comida,amount)).status,400,String(amount));
  for(const month of ['2026-13','2026-1','octubre','2026-10-01'])assert.equal((await put(month,comida,'1')).status,400,month);
  assert.equal((await put('2026-10',randomUUID(),'1')).status,404);
  assert.equal((await put('2026-10','no-uuid','1')).status,400);
  assert.equal((await call('/api/budgets?month=hoy',ana.token)).status,400);
  assert.equal((await call('/api/budgets/2026-10/'+salud,ana.token,'DELETE')).status,404);
 });
 await t.test('unicidad: un presupuesto por familia, categoría, mes y moneda; los meses son independientes',async()=>{
  assert.equal((await put('2026-10',comida,'120000')).status,204);
  assert.equal((await q("SELECT count(*)::int n FROM appgastos.budgets WHERE category_id=$1 AND month='2026-10-01'",[comida])).rows[0].n,1);
  await assert.rejects(q("INSERT INTO appgastos.budgets(family_id,category_id,month,currency,amount) VALUES($1,$2,'2026-10-01','ARS',5)",[INITIAL_FAMILY_ID,comida]),/unique|duplicate/i);
  await assert.rejects(q("INSERT INTO appgastos.budgets(family_id,category_id,month,currency,amount) VALUES($1,$2,'2026-10-15','ARS',5)",[INITIAL_FAMILY_ID,comida]),/check/i);
  assert.equal((await put('2026-11',comida,'90000')).status,204);
  assert.equal(line(await report('2026-10'),comida).amount,'120000.00');
  assert.equal(line(await report('2026-11'),comida).amount,'90000.00');
  assert.equal((await q('SELECT updated_by_member_id FROM appgastos.budgets WHERE category_id=$1 AND month=$2',[comida,'2026-10-01'])).rows[0].updated_by_member_id,ana.id);
 });
 await t.test('consumo: todos los gastos de la categoría del mes, personales y de la casa, una sola vez',async()=>{
  const before=await expenseCount();
  await spend(beto.token,comida,'2026-10-05','30000');
  await spend(ana.token,comida,'2026-10-20','20000',{scope:'household'});
  await spend(ana.token,comida,'2026-11-02','7000');                       // otro mes
  await spend(ana.token,comida,'2026-10-06','50',{currency:'USD'});        // otra moneda
  await spend(ana.token,ocio,'2026-10-07','4000');                         // sin presupuesto
  const r=await report('2026-10'),c=line(r,comida);
  assert.equal(c.spent,'50000.00');assert.equal(c.available,'70000.00');assert.equal(c.percent,41.7);assert.equal(c.exceeded,false);
  assert.deepEqual(r.unbudgeted.map((u:any)=>[u.categoryName,u.spent]),[['Ocio','4000.00']]);
  assert.equal(r.totals.budgeted,'120000.00');assert.equal(r.totals.spent,'50000.00');assert.equal(r.totals.available,'70000.00');
  assert.equal(r.totals.unbudgetedSpent,'4000.00');assert.equal(r.totals.totalSpent,'54000.00');assert.equal(r.totals.exceededCount,0);
  assert.equal(await expenseCount(),before+5,'el presupuesto no crea gastos');
 });
 await t.test('los cambios en los gastos se reflejan: importe, fecha, categoría, borrado',async()=>{
  const e=(await spend(ana.token,comida,'2026-10-10','10000')).expense.id;
  assert.equal(line(await report('2026-10'),comida).spent,'60000.00');
  await call('/api/expenses/'+e,ana.token,'PATCH',{amount:'80000'});
  const over=line(await report('2026-10'),comida);
  assert.equal(over.spent,'130000.00');assert.equal(over.exceeded,true);assert.equal(over.available,'-10000.00');
  assert.equal((await report('2026-10')).totals.exceededCount,1);
  await call('/api/expenses/'+e,ana.token,'PATCH',{categoryId:salud});
  assert.equal(line(await report('2026-10'),comida).spent,'50000.00');
  assert.ok((await report('2026-10')).unbudgeted.some((u:any)=>u.categoryName==='Salud'&&u.spent==='80000.00'));
  await call('/api/expenses/'+e,ana.token,'PATCH',{categoryId:comida,date:'2026-11-03'});
  assert.equal(line(await report('2026-10'),comida).spent,'50000.00');
  assert.equal(line(await report('2026-11'),comida).spent,'87000.00');
  await call('/api/expenses/'+e,ana.token,'DELETE');
  assert.equal(line(await report('2026-11'),comida).spent,'7000.00');
 });
 await t.test('copiar de un mes a otro: no pisa lo existente ni toca otros meses',async()=>{
  assert.equal((await put('2026-10',salud,'30000')).status,204);
  assert.equal((await put('2026-12',comida,'11111')).status,204);
  const first=await json(await call('/api/budgets/copy',ana.token,'POST',{from:'2026-10',to:'2026-11'}));
  assert.equal(first.copied,1,'solo Salud: Alimentación ya existía en noviembre');
  const nov=await report('2026-11');
  assert.equal(line(nov,comida).amount,'90000.00');assert.equal(line(nov,salud).amount,'30000.00');
  assert.equal((await json(await call('/api/budgets/copy',ana.token,'POST',{from:'2026-10',to:'2026-11'}))).copied,0);
  assert.equal(line(await report('2026-12'),comida).amount,'11111.00');
  assert.equal((await call('/api/budgets/copy',ana.token,'POST',{from:'2026-10',to:'2026-10'})).status,400);
  assert.equal((await call('/api/budgets/copy',ana.token,'POST',{from:'x',to:'2026-10'})).status,400);
  assert.equal((await call('/api/budgets/2026-11/'+salud,ana.token,'DELETE')).status,204);
  assert.equal(line(await report('2026-11'),salud),undefined);
 });
 await t.test('un mes sin presupuesto devuelve ceros y deja ver los gastos como no presupuestados',async()=>{
  const r=await report('2027-03');
  assert.deepEqual(r.budgets,[]);assert.equal(r.totals.budgeted,'0.00');assert.equal(r.totals.percent,0);
 });
});
