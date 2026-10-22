// Fase 3: control financiero. Datos sintéticos; las fechas relativas al mes actual evitan depender del día en que corre la prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionApp,INITIAL_FAMILY_ID} from './helpers/sessionApp';
import {referenceDate} from '../src/backend/whatsapp/candidate';

const cur=referenceDate(new Date()).slice(0,7);
const addM=(ym:string,n:number)=>{const [y,m]=ym.split('-').map(Number);return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);};

test('Fase 3: presupuestos recurrentes, categorías jerárquicas y gastos fijos separados',async(t)=>{
 const app=await sessionApp();
 const {q,call,json}=app;
 t.after(()=>app.stop());
 const ana=await app.account('ana',{role:'admin'}),beto=await app.account('beto');
 const get=async(path:string,token=ana.token)=>json(await call(path,token));
 const report=(month:string)=>get('/api/budgets?month='+month);
 const line=(r:any,id:string)=>r.budgets.find((b:any)=>b.categoryId===id);
 const base=(cat:string,amount:unknown,from?:string,token=ana.token)=>call('/api/budgets/base/'+cat,token,'PUT',{amount,...(from?{from}:{})});
 const exception=(month:string,cat:string,amount:unknown)=>call('/api/budgets/'+month+'/'+cat,ana.token,'PUT',{amount});
 const spend=async(cat:string,date:string,amount:string,extra:Record<string,unknown>={})=>json(await app.expense(ana.token,cat,{date,amount,...extra}));
 const newCategory=async(name:string,parentId?:string)=>(await json(await call('/api/categories',ana.token,'POST',{name,...(parentId?{parentId}:{})}))).category.id as string;
 const summary=(month:string)=>get('/api/control/summary?month='+month);
 const wipe=async()=>{
  for(const sql of ['DELETE FROM appgastos.fixed_expense_occurrences','DELETE FROM appgastos.fixed_expenses','DELETE FROM appgastos.budget_bases','DELETE FROM appgastos.budgets','DELETE FROM appgastos.expense_items','DELETE FROM appgastos.expenses'])await q(sql);
 };
 const expenseCount=async()=>(await q('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n as number;

 await t.test('presupuesto base recurrente: se renueva solo cada mes y el gasto de un mes no baja el siguiente (3A-1)',async()=>{
  const ali=await app.category('Alimentación');
  assert.equal((await base(ali,'500000',cur)).status,204);
  await spend(ali,cur+'-05','120000');
  const now=await report(cur);assert.equal(line(now,ali).amount,'500000.00');assert.equal(line(now,ali).spent,'120000.00');assert.equal(line(now,ali).available,'380000.00');assert.equal(line(now,ali).source,'base');
  for(const m of [addM(cur,1),addM(cur,2),addM(cur,14)]){const r=await report(m);assert.equal(line(r,ali).amount,'500000.00',m);assert.equal(line(r,ali).spent,'0.00',m+': sin saldo trasladado');assert.equal(line(r,ali).available,'500000.00',m);}
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.budgets')).rows[0].n,0,'no se crean filas por mes: se calcula por período');
  assert.equal((await report(addM(cur,-1))).budgets.length,0,'meses anteriores a la vigencia no tienen presupuesto');
 });

 await t.test('cambiar la base rige hacia adelante y no altera meses anteriores (3A-3)',async()=>{
  const ali=(await q("SELECT id FROM appgastos.categories WHERE name='Alimentación'")).rows[0].id;
  assert.equal((await base(ali,'650000',addM(cur,3))).status,204);
  assert.equal(line(await report(addM(cur,2)),ali).amount,'500000.00');assert.equal(line(await report(cur),ali).amount,'500000.00');
  assert.equal(line(await report(addM(cur,3)),ali).amount,'650000.00');assert.equal(line(await report(addM(cur,9)),ali).amount,'650000.00');
  // Terminar la base conserva el historial.
  assert.equal((await call('/api/budgets/base/'+ali+'?from='+addM(cur,6),ana.token,'DELETE')).status,204);
  assert.equal(line(await report(addM(cur,5)),ali).amount,'650000.00');assert.equal(line(await report(addM(cur,6)),ali),undefined);
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.budget_bases WHERE category_id=$1',[ali])).rows[0].n,3,'ningún cambio borra historial');
  assert.equal((await call('/api/budgets/base/'+ali+'?from='+addM(cur,-5),ana.token,'DELETE')).status,404,'no había base vigente entonces');
 });

 await t.test('excepción de un mes: reemplaza la base solo ese mes y quitarla vuelve a la base (3A-4)',async()=>{
  const ali=(await q("SELECT id FROM appgastos.categories WHERE name='Alimentación'")).rows[0].id,m=addM(cur,1);
  assert.equal((await exception(m,ali,'300000')).status,204);
  const r=await report(m);assert.equal(line(r,ali).amount,'300000.00');assert.equal(line(r,ali).source,'exception');assert.equal(line(r,ali).baseAmount,'500000.00');
  assert.equal(line(await report(cur),ali).amount,'500000.00');assert.equal(line(await report(addM(cur,2)),ali).amount,'500000.00');
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.budget_bases WHERE category_id=$1 AND amount=300000',[ali])).rows[0].n,0,'la base no se modificó');
  assert.equal((await call('/api/budgets/'+m+'/'+ali,ana.token,'DELETE')).status,204);
  assert.equal(line(await report(m),ali).amount,'500000.00');
  // Solo administradores.
  assert.equal((await base(ali,'1',undefined,beto.token)).status,403);
  assert.equal((await call('/api/budgets/base/'+ali,beto.token,'DELETE')).status,403);
  assert.equal((await call('/api/control/summary?month='+cur,beto.token)).status,403);
 });

 await t.test('categorías y subcategorías: solo administradores, dos niveles, sin duplicados ni ciclos, sin borrar (3B)',async()=>{
  const alim=await newCategory('Alimentos y bebidas'),super_=await newCategory('Compras del hogar',alim),delivery=await newCategory('Delivery',alim);
  const list=(await get('/api/categories',beto.token)).categories;
  assert.equal(list.find((c:any)=>c.id===super_).parentId,alim);assert.equal(list.find((c:any)=>c.id===alim).parentId,null,'los integrantes las leen');
  // Permisos.
  assert.equal((await call('/api/categories',beto.token,'POST',{name:'Otra'})).status,403);
  assert.equal((await call('/api/categories/'+alim,beto.token,'PATCH',{name:'X'})).status,403);
  // Reglas de estructura.
  assert.equal((await call('/api/categories',ana.token,'POST',{name:'Verdulería',parentId:super_})).status,400,'tercer nivel');
  assert.equal((await call('/api/categories/'+alim,ana.token,'PATCH',{parentId:super_})).status,400,'ciclo / padre con hijos');
  assert.equal((await call('/api/categories/'+alim,ana.token,'PATCH',{parentId:delivery})).status,400);
  assert.equal((await call('/api/categories/'+super_,ana.token,'PATCH',{parentId:super_})).status,400,'ella misma');
  assert.equal((await call('/api/categories',ana.token,'POST',{name:'compras del hogar'})).status,409,'nombre repetido (sin importar mayúsculas)');
  assert.equal((await call('/api/categories',ana.token,'POST',{name:'X',parentId:'00000000-0000-4000-8000-0000000000aa'})).status,404);
  assert.equal((await call('/api/categories',ana.token,'POST',{name:'X',extra:1})).status,400);
  assert.equal((await call('/api/categories/'+alim,ana.token,'DELETE')).status,404,'no existe borrado');
  await assert.rejects(q('DELETE FROM appgastos.categories WHERE id=$1',[alim]),/foreign key|violates/i,'la base protege las referencias');
  await assert.rejects(q("UPDATE appgastos.categories SET parent_id=$1 WHERE id=$2",[super_,alim]),/category_depth/,'la base impide un tercer nivel');
  // Reorganizar y archivar conservan los movimientos históricos.
  const e=(await spend(super_,cur+'-06','5000')).expense;
  assert.equal((await call('/api/categories/'+super_,ana.token,'PATCH',{parentId:null})).status,200);
  assert.equal((await call('/api/categories/'+super_,ana.token,'PATCH',{name:'Súper',active:false})).status,200);
  const after=(await get('/api/expenses/'+e.id)).expense;assert.equal(after.categoryId,super_,'el gasto sigue apuntando a la misma categoría');assert.equal(after.categoryName,'Súper');
  assert.equal((await app.expense(ana.token,super_,{amount:'10'})).status,400,'archivada: no se usa en gastos nuevos');
  assert.equal((await call('/api/categories/'+super_,ana.token,'PATCH',{active:true,parentId:alim})).status,200);
  assert.equal((await app.expense(ana.token,super_,{amount:'10',date:cur+'-07'})).status,201,'reactivada');
 });

 await t.test('presupuestos jerárquicos: el padre incluye a los hijos, sin doble contabilización y con límites (3B/3C)',async()=>{
  await wipe();
  const alim=(await q("SELECT id FROM appgastos.categories WHERE name='Alimentos y bebidas'")).rows[0].id,sup=(await q("SELECT id FROM appgastos.categories WHERE name='Súper'")).rows[0].id,del=(await q("SELECT id FROM appgastos.categories WHERE name='Delivery'")).rows[0].id;
  assert.equal((await base(alim,'500000',cur)).status,204);assert.equal((await base(sup,'300000',cur)).status,204);assert.equal((await base(del,'80000',cur)).status,204);
  let r=await report(cur);
  assert.equal(r.totals.budgeted,'500000.00','500.000, no 880.000');
  assert.deepEqual(r.budgets.filter((b:any)=>b.parentId===alim).map((b:any)=>b.categoryName).sort(),['Delivery','Súper']);
  await spend(sup,cur+'-05','100000');await spend(del,cur+'-06','50000');await spend(alim,cur+'-07','20000');
  r=await report(cur);
  assert.equal(line(r,sup).spent,'100000.00');assert.equal(line(r,del).spent,'50000.00');assert.equal(line(r,alim).spent,'170000.00','el padre consume lo de sus hijos y lo directo');
  assert.equal(r.totals.spent,'170000.00','cada gasto una sola vez');assert.equal(r.totals.available,'330000.00');assert.equal(r.totals.totalSpent,'170000.00');assert.equal(r.unbudgeted.length,0);
  // Los hijos no pueden sumar más que el límite explícito del padre; ni el padre bajar de lo que suman los hijos.
  assert.equal((await base(del,'250000',cur)).status,409);
  assert.equal((await base(alim,'350000',cur)).status,409);
  assert.equal((await exception(cur,del,'250000')).status,409);
  assert.equal((await base(del,'200000',cur)).status,204,'300.000 + 200.000 = 500.000 entra justo');
  // Sin presupuesto padre no se inventa uno: solo el hijo presupuestado cuenta; el gasto directo del padre queda sin presupuestar.
  assert.equal((await call('/api/budgets/base/'+alim+'?from='+cur,ana.token,'DELETE')).status,204);
  r=await report(cur);assert.equal(line(r,alim),undefined);assert.equal(r.totals.budgeted,'500000.00','Súper 300.000 + Delivery 200.000');
  assert.equal(r.totals.spent,'150000.00');assert.deepEqual(r.unbudgeted.map((u:any)=>[u.categoryName,u.spent]),[['Alimentos y bebidas','20000.00']]);assert.equal(r.totals.totalSpent,'170000.00');
 });

 await t.test('ticket con conceptos de varias categorías: cada importe consume una vez su categoría y la del padre (3C-6)',async()=>{
  await wipe();
  const alim=(await q("SELECT id FROM appgastos.categories WHERE name='Alimentos y bebidas'")).rows[0].id,sup=(await q("SELECT id FROM appgastos.categories WHERE name='Súper'")).rows[0].id,lim=await app.category('Limpieza');
  assert.equal((await base(alim,'200000',cur)).status,204);assert.equal((await base(lim,'50000',cur)).status,204);
  await q(`WITH e AS (INSERT INTO appgastos.expenses(family_id,date,amount,currency,description,category_id,payment_method,reported_by_member_id,scope) VALUES($1,$2,20000,'ARS','Ticket súper',$3,'cash',$4,'household') RETURNING id)
   INSERT INTO appgastos.expense_items(expense_id,family_id,position,description,category_id,amount) SELECT id,$1,0,'Verdura',$3,12000 FROM e UNION ALL SELECT id,$1,1,'Detergente',$5,8000 FROM e`,[INITIAL_FAMILY_ID,cur+'-08',sup,ana.id,lim]);
  const r=await report(cur);
  assert.equal(line(r,alim).spent,'12000.00','Verdura consume Alimentos (por su hijo)');assert.equal(line(r,lim).spent,'8000.00');assert.equal(r.totals.totalSpent,'20000.00','el total del ticket una sola vez');
 });

 await t.test('gastos fijos: renuevan cada mes, conservan deudas anteriores y no duplican (3A-2)',async()=>{
  await wipe();
  const edu=await app.category('Educación');
  const fixed=(await json(await call('/api/fixed-expenses',ana.token,'POST',{name:'Colegio',categoryId:edu,expectedAmount:'180000',dueDay:10,startDate:addM(cur,-2)+'-01'}))).fixedExpense;
  const s1=await summary(cur),s2=await summary(cur);
  assert.deepEqual(s1.fixed,s2.fixed,'consultar de nuevo no genera obligaciones duplicadas');
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1',[fixed.id])).rows[0].n,3);
  assert.deepEqual([s1.fixed.pending.count,s1.fixed.pending.amount,s1.fixed.previousDebts.count,s1.fixed.previousDebts.amount],[1,'180000.00',2,'360000.00'],'mes actual pendiente + 2 deudas anteriores');
  assert.equal(s1.fixed.paid.amount,'0.00');assert.equal(s1.totalSpent,'0.00','lo pendiente no es gasto');
  const next=await summary(addM(cur,1));assert.equal(next.fixed.pending.count,1);assert.equal(next.fixed.previousDebts.count,3,'las impagas siguen visibles y no se pierden');
  assert.equal((await q("SELECT count(*)::int n FROM appgastos.fixed_expense_amounts WHERE fixed_expense_id=$1 AND amount=180000",[fixed.id])).rows[0].n,1);
 });

 await t.test('cambiar el importe de un gasto fijo "desde un mes" no toca lo anterior ni lo pagado (3A)',async()=>{
  const f=(await q("SELECT id FROM appgastos.fixed_expenses WHERE name='Colegio'")).rows[0].id;
  await summary(addM(cur,3));
  const paidOcc=(await q("SELECT id FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1 AND period=$2",[f,addM(cur,-2)+'-01'])).rows[0].id;
  assert.equal((await call('/api/fixed-expenses/occurrences/'+paidOcc+'/pay',ana.token,'POST',{paymentMethod:'transfer',date:cur+'-03'})).status,201);
  assert.equal((await call('/api/fixed-expenses/'+f,ana.token,'PATCH',{expectedAmount:'200000',effectiveFrom:addM(cur,2)})).status,200);
  const amounts=async()=>Object.fromEntries((await q("SELECT to_char(period,'YYYY-MM') m,expected_amount::text a FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1",[f])).rows.map((r:any)=>[r.m,r.a]));
  let a=await amounts();
  assert.equal(a[addM(cur,-2)],'180000.00');assert.equal(a[cur],'180000.00');assert.equal(a[addM(cur,1)],'180000.00');assert.equal(a[addM(cur,2)],'200000.00');assert.equal(a[addM(cur,3)],'200000.00');
  // Una obligación que se genera después toma el importe vigente de SU período.
  await summary(addM(cur,5));a=await amounts();assert.equal(a[addM(cur,5)],'200000.00');
  assert.equal((await q('SELECT amount::text a FROM appgastos.expenses WHERE id=(SELECT expense_id FROM appgastos.fixed_expense_occurrences WHERE id=$1)',[paidOcc])).rows[0].a,'180000.00','el pago histórico queda como estaba');
  assert.equal((await call('/api/fixed-expenses/'+f,ana.token,'PATCH',{effectiveFrom:addM(cur,2)})).status,400,'effectiveFrom solo con importe');
 });

 await t.test('pago de gasto fijo: un solo movimiento, no consume el presupuesto variable y el repetido no duplica (3A-7/8, 3C)',async()=>{
  await wipe();
  const edu=await app.category('Educación');
  assert.equal((await base(edu,'100000',cur)).status,204);
  const f=(await json(await call('/api/fixed-expenses',ana.token,'POST',{name:'Colegio',categoryId:edu,expectedAmount:'180000',dueDay:10,startDate:cur+'-01'}))).fixedExpense.id;
  await spend(edu,cur+'-04','30000',{description:'Útiles'});
  const occ=(await get('/api/fixed-expenses/occurrences?month='+cur)).occurrences[0];
  const before=await expenseCount();
  const paid=await call('/api/fixed-expenses/occurrences/'+occ.id+'/pay',ana.token,'POST',{paymentMethod:'transfer',date:cur+'-09'});assert.equal(paid.status,201);
  assert.equal(await expenseCount(),before+1);
  const r=await report(cur);assert.equal(line(r,edu).spent,'30000.00','pagar el colegio no descuenta de Educación');assert.equal(r.totals.totalSpent,'30000.00');
  const s=await summary(cur);
  assert.deepEqual([s.fixed.paid.amount,s.fixed.pending.count,s.variable.registered,s.variable.available,s.totalSpent],['180000.00',0,'30000.00','70000.00','210000.00'],'total = fijos pagados + variables');
  // Repetido: no crea otro movimiento ni cambia los totales.
  assert.equal((await call('/api/fixed-expenses/occurrences/'+occ.id+'/pay',ana.token,'POST',{paymentMethod:'transfer'})).status,409);
  assert.equal(await expenseCount(),before+1);assert.equal((await summary(cur)).totalSpent,'210000.00');
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE expense_id IS NOT NULL')).rows[0].n,1);
  // Un integrante no paga obligaciones (no las ve).
  assert.equal((await call('/api/fixed-expenses/occurrences/'+occ.id+'/pay',beto.token,'POST',{paymentMethod:'cash'})).status,403);
  assert.ok(f);
 });

 await t.test('pago atrasado: la obligación conserva su mes de origen y el pago cuenta en el mes efectivo, sin duplicar (3A-11)',async()=>{
  await wipe();
  const edu=await app.category('Educación'),prev=addM(cur,-1);
  await call('/api/fixed-expenses',ana.token,'POST',{name:'Colegio',categoryId:edu,expectedAmount:'180000',dueDay:10,startDate:prev+'-01'});
  const before=await summary(cur);assert.deepEqual([before.fixed.previousDebts.count,before.fixed.paid.amount],[1,'0.00']);
  const late=(await q("SELECT id FROM appgastos.fixed_expense_occurrences WHERE period=$1",[prev+'-01'])).rows[0].id;
  assert.equal((await call('/api/fixed-expenses/occurrences/'+late+'/pay',ana.token,'POST',{paymentMethod:'transfer',date:cur+'-02'})).status,201);
  const now=await summary(cur),old=await summary(prev);
  assert.deepEqual([now.fixed.paid.amount,now.fixed.paidLate.amount,now.fixed.previousDebts.count,now.totalSpent],['180000.00','180000.00',0,'180000.00'],'se paga en el mes actual');
  assert.deepEqual([old.fixed.paid.amount,old.fixed.pending.count,old.totalSpent],['0.00',0,'0.00'],'el mes de origen no recibe el gasto, y su obligación ya no está pendiente');
  assert.equal((await q("SELECT to_char(period,'YYYY-MM') p FROM appgastos.fixed_expense_occurrences WHERE id=$1",[late])).rows[0].p,prev,'la obligación sigue asociada a su mes de origen');
  assert.equal(await expenseCount(),1);
 });

 await t.test('regresión: lo histórico se conserva al reorganizar y los gastos no cambian (3F-14)',async()=>{
  const total=(await q('SELECT count(*)::int n,COALESCE(sum(amount),0)::text s FROM appgastos.expenses')).rows[0];
  const cat=(await q("SELECT id FROM appgastos.categories WHERE name='Educación'")).rows[0].id;
  const parent=await newCategory('Hogar y educación');
  assert.equal((await call('/api/categories/'+cat,ana.token,'PATCH',{parentId:parent})).status,200);
  const after=(await q('SELECT count(*)::int n,COALESCE(sum(amount),0)::text s FROM appgastos.expenses')).rows[0];
  assert.deepEqual(after,total);
  assert.equal((await q('SELECT count(*)::int n FROM appgastos.expenses WHERE category_id=$1',[cat])).rows[0].n>0,true,'los movimientos siguen con su categoría');
 });
});
