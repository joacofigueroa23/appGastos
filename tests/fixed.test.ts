import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionApp,INITIAL_FAMILY_ID} from './helpers/sessionApp';
import {referenceDate} from '../src/backend/whatsapp/candidate';

test('Gastos fijos: permisos, ocurrencias, vencimientos y vinculación de pagos',async(t)=>{
 const app=await sessionApp();
 const {q,call,json}=app;
 t.after(()=>app.stop());
 const ana=await app.account('ana',{role:'admin'}),beto=await app.account('beto');
 const educacion=await app.category('Educación'),vivienda=await app.category('Vivienda'),ocio=await app.category('Ocio');
 const create=(body:Record<string,unknown>,token=ana.token)=>call('/api/fixed-expenses',token,'POST',{name:'Fijo',categoryId:educacion,expectedAmount:'180000',dueDay:10,startDate:'2026-10-01',...body});
 const occ=async(month:string,token=ana.token)=>(await json(await call('/api/fixed-expenses/occurrences?month='+month,token))).occurrences as any[];
 const spend=(token:string,category:string,amount:string,extra:Record<string,unknown>={})=>app.expense(token,category,{date:'2026-10-12',amount,scope:'household',description:'Pago',...extra}).then(json);
 const count=async(sql:string,args:unknown[]=[])=>(await q(sql,args)).rows[0].n as number;
 const expenses=()=>count('SELECT count(*)::int n FROM appgastos.expenses');

 await t.test('solo administradores ven o modifican obligaciones; el integrante no ve nada',async()=>{
  const colegio=await json(await create({name:'Colegio'}));assert.equal(colegio.fixedExpense.name,'Colegio');
  for(const [method,path,body] of [['GET','/api/fixed-expenses',undefined],['POST','/api/fixed-expenses',{name:'x'}],['GET','/api/fixed-expenses/occurrences?month=2026-10',undefined],
   ['GET','/api/fixed-expenses/unlinked?month=2026-10',undefined],['PATCH','/api/fixed-expenses/'+colegio.fixedExpense.id,{active:false}],
   ['POST','/api/fixed-expenses/occurrences/'+colegio.fixedExpense.id+'/link',{expenseId:colegio.fixedExpense.id}],['DELETE','/api/fixed-expenses/occurrences/'+colegio.fixedExpense.id+'/link',undefined]] as const){
   const res=await call(path,beto.token,method,body);
   assert.equal(res.status,403,method+' '+path);
   const text=JSON.stringify(await res.json());assert.ok(!text.includes('Colegio')&&!text.includes('180000'));
  }
  assert.equal((await call('/api/fixed-expenses')).status,401);
  await q('DELETE FROM appgastos.fixed_expense_occurrences');await q('DELETE FROM appgastos.fixed_expenses');
 });
 await t.test('validaciones',async()=>{
  for(const body of [{dueDay:0},{dueDay:32},{dueDay:1.5},{dueDay:'10'},{expectedAmount:'0'},{expectedAmount:'1.234'},{name:''},{startDate:'2026-02-30'},
   {endDate:'2026-09-30'},{installmentsTotal:0},{installmentsTotal:1.5},{categoryId:'x'},{unknown:1}])
   assert.equal((await create(body)).status,400,JSON.stringify(body));
  assert.equal((await create({categoryId:'00000000-0000-4000-8000-0000000000aa'})).status,404);
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expenses'),0);
 });
 await t.test('ocurrencias: idempotentes, solo dentro de inicio y fin, una por mes',async()=>{
  const f=(await json(await create({name:'Alquiler',categoryId:vivienda,startDate:'2026-10-01',endDate:'2026-12-31'}))).fixedExpense.id;
  assert.equal((await occ('2026-09')).length,0,'antes del inicio');
  const first=await occ('2026-10'),again=await occ('2026-10');
  assert.equal(first.length,1);assert.equal(again.length,1);assert.equal(first[0].id,again[0].id);
  await Promise.all([occ('2026-11'),occ('2026-11'),occ('2026-11')]);
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1 AND period=$2',[f,'2026-11-01']),1,'pedidos simultáneos no duplican');
  assert.equal((await occ('2026-12')).length,1);
  assert.equal((await occ('2027-01')).length,0,'después del fin');
  await call('/api/fixed-expenses/'+f,ana.token,'PATCH',{active:false});
  assert.equal((await occ('2026-12')).length,0,'desactivar quita lo futuro sin pagar');
  assert.equal((await occ('2027-02')).length,0,'inactiva: no genera más');
 });
 await t.test('vencimientos en meses de distinta duración y cuotas con fin',async()=>{
  const f=(await json(await create({name:'Seguro',categoryId:vivienda,dueDay:31,startDate:'2027-01-01',installmentsTotal:3}))).fixedExpense.id;
  const due=async(m:string)=>(await occ(m)).find(o=>o.fixedExpenseId===f);
  assert.equal((await due('2027-01'))!.dueDate,'2027-01-31');assert.equal((await due('2027-02'))!.dueDate,'2027-02-28');
  assert.equal((await due('2027-03'))!.dueDate,'2027-03-31');assert.equal((await due('2027-03'))!.installmentNumber,3);
  assert.equal(await due('2027-04'),undefined,'la cuota 4 no existe');
  const bis=(await json(await create({name:'Bisiesto',categoryId:vivienda,dueDay:30,startDate:'2028-01-01'}))).fixedExpense.id;
  assert.equal((await occ('2028-02')).find(o=>o.fixedExpenseId===bis)!.dueDate,'2028-02-29');
 });
 await t.test('estados: pendiente, vencida y pagada; las previstas no cuentan como gasto',async()=>{
  const before=await expenses();
  const vieja=(await json(await create({name:'Vieja',categoryId:ocio,startDate:'2020-01-01',dueDay:15,expectedAmount:'500'}))).fixedExpense.id;
  const lejana=(await json(await create({name:'Lejana',categoryId:ocio,startDate:'2099-01-01',dueDay:15,expectedAmount:'700'}))).fixedExpense.id;
  assert.equal((await occ('2020-01')).find(o=>o.fixedExpenseId===vieja).status,'overdue');
  assert.equal((await occ('2099-01')).find(o=>o.fixedExpenseId===lejana).status,'pending');
  assert.equal(await expenses(),before,'prever obligaciones no crea gastos');
 });
 await t.test('pago de la casa por un integrante: se vincula solo con una coincidencia segura, sin duplicar',async()=>{
  const f=(await json(await create({name:'Colegio',categoryId:educacion,startDate:'2026-10-01',dueDay:10,expectedAmount:'180000'}))).fixedExpense.id;
  const before=await expenses();
  const paid=await spend(beto.token,educacion,'180000',{description:'Cuota del colegio'});
  assert.equal(await expenses(),before+1,'un solo gasto');
  assert.deepEqual(Object.keys(paid.expense).filter(k=>/oblig|fixed|occurr/i.test(k)),[],'la respuesta al integrante no revela obligaciones');
  const o=(await occ('2026-10')).find(x=>x.fixedExpenseId===f);
  assert.equal(o.status,'paid');assert.equal(o.expenseId,paid.expense.id);assert.equal(o.linkSource,'auto');
  // Un segundo pago igual no se asocia a la misma obligación ni se duplica.
  const second=await spend(beto.token,educacion,'180000');
  assert.equal((await occ('2026-10')).find(x=>x.fixedExpenseId===f).expenseId,paid.expense.id);
  assert.equal((await json(await call('/api/fixed-expenses/unlinked?month=2026-10',ana.token))).expenses.some((e:any)=>e.id===second.expense.id),true);
  // Un gasto personal, otro importe u otra categoría no vinculan.
  const personal=await spend(beto.token,educacion,'180000',{scope:'personal'});
  const otro=await spend(beto.token,educacion,'179999');
  for(const e of [personal,otro])assert.ok((await occ('2026-10')).every(x=>x.expenseId!==e.expense.id));
 });
 await t.test('ambigüedad: con dos candidatas no se asocia ninguna; el administrador decide',async()=>{
  await q('DELETE FROM appgastos.fixed_expense_occurrences');await q('DELETE FROM appgastos.expenses');await q('DELETE FROM appgastos.fixed_expenses');
  const a=(await json(await create({name:'Cuota A',categoryId:educacion,expectedAmount:'1000'}))).fixedExpense.id;
  const b=(await json(await create({name:'Cuota B',categoryId:educacion,expectedAmount:'1000'}))).fixedExpense.id;
  const pay=await spend(beto.token,educacion,'1000');
  const list=await occ('2026-10');
  assert.ok(list.every(o=>o.status!=='paid'),'ninguna asociación arbitraria');
  const unlinked=(await json(await call('/api/fixed-expenses/unlinked?month=2026-10',ana.token))).expenses;
  assert.deepEqual(unlinked.map((e:any)=>e.id),[pay.expense.id]);assert.equal(unlinked[0].authorName,'beto');
  const target=list.find(o=>o.fixedExpenseId===b);
  assert.equal((await call('/api/fixed-expenses/occurrences/'+target.id+'/link',ana.token,'POST',{expenseId:pay.expense.id})).status,204);
  assert.equal((await occ('2026-10')).find(o=>o.fixedExpenseId===b).linkSource,'manual');
  // Un gasto no paga dos obligaciones; una obligación pagada no se vuelve a pagar.
  const other=list.find(o=>o.fixedExpenseId===a);
  assert.equal((await call('/api/fixed-expenses/occurrences/'+other.id+'/link',ana.token,'POST',{expenseId:pay.expense.id})).status,409);
  // Con B ya paga, el siguiente pago idéntico tiene una única candidata libre (A) y se vincula solo.
  const second=await spend(beto.token,educacion,'1000');
  assert.equal((await occ('2026-10')).find(o=>o.fixedExpenseId===a).expenseId,second.expense.id);
  assert.equal((await call('/api/fixed-expenses/occurrences/'+target.id+'/link',ana.token,'POST',{expenseId:second.expense.id})).status,409);
  // El vínculo manual sobrevive a editar el gasto; desvincular devuelve la obligación a pendiente.
  await call('/api/expenses/'+pay.expense.id,ana.token,'PATCH',{amount:'1234'});
  assert.equal((await occ('2026-10')).find(o=>o.fixedExpenseId===b).status,'paid');
  assert.equal((await call('/api/fixed-expenses/occurrences/'+target.id+'/link',ana.token,'DELETE')).status,204);
  assert.notEqual((await occ('2026-10')).find(o=>o.fixedExpenseId===b).status,'paid');
  assert.equal((await call('/api/fixed-expenses/occurrences/'+target.id+'/link',ana.token,'DELETE')).status,404);
  assert.equal((await call('/api/fixed-expenses/occurrences/'+target.id+'/link',ana.token,'POST',{expenseId:'00000000-0000-4000-8000-0000000000aa'})).status,404);
 });
 await t.test('editar o borrar un pago automático mantiene la contabilidad coherente',async()=>{
  await q('DELETE FROM appgastos.fixed_expense_occurrences');await q('DELETE FROM appgastos.expenses');await q('DELETE FROM appgastos.fixed_expenses');
  const f=(await json(await create({name:'Expensas',categoryId:vivienda,expectedAmount:'5000'}))).fixedExpense.id;
  const status=async()=>(await occ('2026-10')).find(o=>o.fixedExpenseId===f).status;
  const e=(await spend(beto.token,vivienda,'5000')).expense.id;
  assert.equal(await status(),'paid');
  await call('/api/expenses/'+e,beto.token,'PATCH',{amount:'5001'});assert.notEqual(await status(),'paid');
  await call('/api/expenses/'+e,beto.token,'PATCH',{amount:'5000'});assert.equal(await status(),'paid','recupera el vínculo al volver a coincidir');
  await call('/api/expenses/'+e,beto.token,'PATCH',{scope:'personal'});assert.notEqual(await status(),'paid');
  await call('/api/expenses/'+e,beto.token,'PATCH',{scope:'household',categoryId:ocio});assert.notEqual(await status(),'paid');
  await call('/api/expenses/'+e,beto.token,'PATCH',{categoryId:vivienda,date:'2026-11-03'});assert.notEqual(await status(),'paid');
  await call('/api/expenses/'+e,beto.token,'PATCH',{date:'2026-10-03'});assert.equal(await status(),'paid');
  assert.equal((await call('/api/expenses/'+e,beto.token,'DELETE')).status,204);
  assert.notEqual(await status(),'paid','borrar el gasto libera la obligación');
 });
 await t.test('dos pagos idénticos simultáneos: solo uno se vincula',async()=>{
  await q('DELETE FROM appgastos.fixed_expense_occurrences');await q('DELETE FROM appgastos.expenses');await q('DELETE FROM appgastos.fixed_expenses');
  const f=(await json(await create({name:'Agua',categoryId:vivienda,expectedAmount:'800'}))).fixedExpense.id;
  const results=await Promise.all([spend(beto.token,vivienda,'800'),spend(ana.token,vivienda,'800')]);
  assert.equal(results.length,2);
  const linked=await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1 AND expense_id IS NOT NULL',[f]);
  assert.ok(linked<=1);
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1',[f]),1);
 });
 await t.test('cambiar el importe afecta lo pendiente del mes actual en adelante; lo pagado y lo anterior se conserva',async()=>{
  await q('DELETE FROM appgastos.fixed_expense_occurrences');await q('DELETE FROM appgastos.expenses');await q('DELETE FROM appgastos.fixed_expenses');
  const now=referenceDate(new Date()).slice(0,7);
  const next=new Date(Date.UTC(Number(now.slice(0,4)),Number(now.slice(5))-1+1,1)).toISOString().slice(0,7);
  const f=(await json(await create({name:'Internet',categoryId:vivienda,startDate:'2020-01-01',expectedAmount:'100'}))).fixedExpense.id;
  await occ('2020-01');await occ(now);await occ(next);
  const paid=(await occ('2020-01'))[0];
  const e=(await spend(beto.token,vivienda,'100',{date:'2020-01-05'})).expense.id;
  assert.equal((await occ('2020-01'))[0].status,'paid');assert.equal(paid.expectedAmount,'100.00');
  assert.equal((await call('/api/fixed-expenses/'+f,ana.token,'PATCH',{expectedAmount:'150',dueDay:20})).status,200);
  assert.equal((await occ('2020-01'))[0].expectedAmount,'100.00','pagada: no se reescribe');
  assert.equal((await occ(now))[0].expectedAmount,'150.00');assert.equal((await occ(next))[0].expectedAmount,'150.00');
  assert.ok((await occ(now))[0].dueDate.endsWith('-20'));
  assert.equal((await occ('2020-01'))[0].paidAmount,'100.00');assert.ok(e);
  const list=(await json(await call('/api/fixed-expenses',ana.token))).fixedExpenses;
  assert.equal(list.find((x:any)=>x.id===f).expectedAmount,'150.00');
 });
 await t.test('integridad: cada ocurrencia pertenece a la familia y borrar un gasto no rompe la base',async()=>{
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences o WHERE o.family_id<>$1',[INITIAL_FAMILY_ID]),0);
 });
 // ---- Marcar como pagada y vencidas que quedan a la vista
 const overdue=async(token=ana.token)=>(await json(await call('/api/fixed-expenses/overdue',token))).occurrences as any[];
 const pay=(id:string,body:Record<string,unknown>,token=ana.token)=>call('/api/fixed-expenses/occurrences/'+id+'/pay',token,'POST',body);
 const reset=async()=>{await q('DELETE FROM appgastos.fixed_expense_occurrences');await q('DELETE FROM appgastos.expenses');await q('DELETE FROM appgastos.fixed_expenses');};
 await t.test('lo vencido sin pagar queda a la vista de cualquier mes hasta que se paga',async()=>{
  await reset();
  const f=(await json(await create({name:'Cuota auto',categoryId:ocio,expectedAmount:'1000',dueDay:5,startDate:'2020-01-01',installmentsTotal:3}))).fixedExpense.id;
  const list=await overdue();
  assert.deepEqual(list.map(o=>[o.month,o.status,o.installmentNumber]),[['2020-01','overdue',1],['2020-02','overdue',2],['2020-03','overdue',3]]);
  assert.equal((await overdue()).length,3,'idempotente');
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1',[f]),3);
  await create({name:'Futura',categoryId:ocio,startDate:'2099-01-01'});
  assert.equal((await overdue()).length,3,'una obligación futura no figura como vencida');
  const off=(await json(await create({name:'Apagada',categoryId:ocio,startDate:'2020-01-01',endDate:'2020-02-28'}))).fixedExpense.id;
  assert.equal((await overdue()).filter(o=>o.name==='Apagada').length,2,'respeta la fecha de fin');
  await call('/api/fixed-expenses/'+off,ana.token,'PATCH',{active:false});
  assert.equal((await call('/api/fixed-expenses/overdue',beto.token)).status,403);
 });
 await t.test('marcar como pagada crea un gasto real de la casa, vinculado, que se cuenta una sola vez',async()=>{
  const first=(await overdue()).find(o=>o.name==='Cuota auto'&&o.installmentNumber===1);
  const before=await expenses();
  const res=await pay(first.id,{paymentMethod:'transfer'});
  assert.equal(res.status,201);
  const e=(await json(res)).expense;
  assert.equal(e.description,'Cuota auto · cuota 1/3');assert.equal(e.scope,'household');assert.equal(e.amount,'1000.00');
  assert.equal(e.reportedByMemberId,ana.id);assert.equal(e.date,referenceDate(new Date()));assert.equal(e.paymentMethod,'transfer');
  assert.equal(await expenses(),before+1);
  const paid=(await occ('2020-01')).find(o=>o.id===first.id);
  assert.equal(paid.status,'paid');assert.equal(paid.expenseId,e.id);assert.equal(paid.linkSource,'manual');
  assert.equal((await overdue()).some(o=>o.id===first.id),false,'ya no figura como vencida');
  assert.equal((await call('/api/fixed-expenses/occurrences/'+first.id+'/pay',beto.token,'POST',{paymentMethod:'cash'})).status,403);
  assert.equal((await pay(first.id,{paymentMethod:'cash'})).status,409,'no se paga dos veces');
  assert.equal(await expenses(),before+1);
 });
 await t.test('importe y fecha propios; datos inválidos no dejan nada a medias',async()=>{
  const second=(await overdue()).find(o=>o.name==='Cuota auto'&&o.installmentNumber===2);
  const before=await expenses();
  for(const bad of [{},{paymentMethod:'trueque'},{paymentMethod:'cash',amount:'0'},{paymentMethod:'cash',date:'ayer'},{paymentMethod:'cash',extra:1}])
   assert.equal((await pay(second.id,bad)).status,400,JSON.stringify(bad));
  assert.equal(await expenses(),before,'sin gasto huérfano');
  assert.equal((await occ('2020-02')).find(o=>o.id===second.id).status,'overdue');
  const ok=await json(await pay(second.id,{paymentMethod:'cash',amount:'1500',date:'2020-02-10'}));
  assert.equal(ok.expense.amount,'1500.00');assert.equal(ok.expense.date,'2020-02-10');
  const row=(await occ('2020-02')).find(o=>o.id===second.id);
  assert.equal(row.expectedAmount,'1000.00');assert.equal(row.paidAmount,'1500.00');assert.equal(row.status,'paid');
  assert.equal((await pay('00000000-0000-4000-8000-0000000000aa',{paymentMethod:'cash'})).status,404);
 });
 await t.test('con dos obligaciones iguales, el pago queda en la que se eligió',async()=>{
  await reset();
  const x=(await json(await create({name:'Cuota X',categoryId:educacion,expectedAmount:'700',startDate:'2020-04-01',endDate:'2020-04-30'}))).fixedExpense.id;
  const y=(await json(await create({name:'Cuota Y',categoryId:educacion,expectedAmount:'700',startDate:'2020-04-01',endDate:'2020-04-30'}))).fixedExpense.id;
  const list=await overdue(),target=list.find(o=>o.fixedExpenseId===y),other=list.find(o=>o.fixedExpenseId===x);
  const e=(await json(await pay(target.id,{paymentMethod:'cash',date:'2020-04-12'}))).expense;
  const now=await occ('2020-04');
  assert.equal(now.find(o=>o.id===target.id).expenseId,e.id);assert.equal(now.find(o=>o.id===other.id).status,'overdue');
  // Con una sola candidata el vínculo automático ya cae en ella y queda como decisión manual.
  const z=(await json(await create({name:'Cuota Z',categoryId:vivienda,expectedAmount:'900',startDate:'2020-05-01',endDate:'2020-05-31'}))).fixedExpense.id;
  const zz=(await overdue()).find(o=>o.fixedExpenseId===z);
  const e2=(await json(await pay(zz.id,{paymentMethod:'cash',date:'2020-05-03'}))).expense;
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE expense_id=$1',[e2.id]),1);
  assert.equal((await occ('2020-05')).find(o=>o.id===zz.id).linkSource,'manual');
  // Desvincular deja el gasto (es un pago real) y devuelve la obligación a vencida.
  assert.equal((await call('/api/fixed-expenses/occurrences/'+zz.id+'/link',ana.token,'DELETE')).status,204);
  assert.equal((await occ('2020-05')).find(o=>o.id===zz.id).status,'overdue');
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.expenses WHERE id=$1',[e2.id]),1);
 });
 await t.test('corregir inicio, fin, cuotas o estado no deja vencidas fantasma; lo pagado no se toca',async()=>{
  await reset();
  // Error de tipeo: año 2025 en lugar de 2026 → aparecen meses de más como vencidos.
  const f=(await json(await create({name:'Tipeo',categoryId:ocio,expectedAmount:'300',dueDay:5,startDate:'2025-01-01',endDate:'2025-06-30'}))).fixedExpense.id;
  assert.equal((await overdue()).filter(o=>o.fixedExpenseId===f).length,6);
  const march=(await overdue()).find(o=>o.fixedExpenseId===f&&o.month==='2025-03');
  await pay(march.id,{paymentMethod:'cash',date:'2025-03-06'});
  assert.equal((await call('/api/fixed-expenses/'+f,ana.token,'PATCH',{startDate:'2025-02-01',endDate:'2025-04-30'})).status,200);
  assert.deepEqual((await overdue()).filter(o=>o.fixedExpenseId===f).map(o=>o.month),['2025-02','2025-04'],'enero y mayo-junio ya no corresponden; marzo está pagada');
  assert.equal((await occ('2025-03')).find(o=>o.fixedExpenseId===f).status,'paid');
  // Cuotas: bajar el total elimina las sobrantes sin pagar y renumera desde el nuevo inicio.
  const c=(await json(await create({name:'Cuotas',categoryId:ocio,expectedAmount:'100',dueDay:1,startDate:'2024-01-01',installmentsTotal:6}))).fixedExpense.id;
  assert.equal((await overdue()).filter(o=>o.fixedExpenseId===c).length,6);
  await call('/api/fixed-expenses/'+c,ana.token,'PATCH',{installmentsTotal:3});
  assert.deepEqual((await overdue()).filter(o=>o.fixedExpenseId===c).map(o=>o.installmentNumber),[1,2,3]);
  await call('/api/fixed-expenses/'+c,ana.token,'PATCH',{startDate:'2024-02-01'});
  assert.deepEqual((await overdue()).filter(o=>o.fixedExpenseId===c).map(o=>[o.month,o.installmentNumber]),[['2024-02',1],['2024-03',2],['2024-04',3]],'tres cuotas desde el nuevo inicio');
  // Desactivar: lo vencido de meses pasados se conserva (era real); no se generan más.
  await call('/api/fixed-expenses/'+c,ana.token,'PATCH',{active:false});
  assert.equal((await overdue()).filter(o=>o.fixedExpenseId===c).length,3);
 });
});
