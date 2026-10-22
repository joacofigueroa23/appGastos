// Fase 3D: administración por WhatsApp. El intérprete de Gemini se simula: lo que se prueba es que el backend valida, pide confirmación,
// respeta roles y es idempotente. Datos sintéticos.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionApp} from './helpers/sessionApp';
import {referenceDate} from '../src/backend/whatsapp/candidate';
import type {AdminIntent} from '../src/backend/whatsapp/adminIntent';

const ANA='5491100000011',BETO='5491100000012';
const cur=referenceDate(new Date()).slice(0,7);
const addM=(ym:string,n:number)=>{const [y,m]=ym.split('-').map(Number);return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);};
const MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const monthName=(ym:string)=>MONTHS[Number(ym.slice(5,7))-1];
const blank:AdminIntent={action:'none',name:null,parent:null,category:null,fixed:null,amount:null,amountText:null,monthText:null,dueDay:null,active:null,paymentMethod:null};

test('Fase 3D: configuración y pagos por WhatsApp con confirmación, roles e idempotencia',async(t)=>{
 let intent:AdminIntent=blank;const calls={admin:0};
 const app=await sessionApp({admin:async()=>{calls.admin++;return intent;}});
 const {q,call,json,incoming,replies}=app;
 t.after(()=>app.stop());
 const ana=await app.account('ana',{role:'admin',phone:ANA}),beto=await app.account('beto',{phone:BETO});
 const alim=await app.category('Alimentos y bebidas'),edu=await app.category('Educación');
 let n=0;
 const say=async(from:string,text:string,as?:Partial<AdminIntent>)=>{if(as)intent={...blank,...as};n++;await incoming('wamid.a'+n,text,from);return replies.at(-1)!.text;};
 const pending=async()=>(await q("SELECT * FROM appgastos.admin_actions WHERE state='pending'")).rows;
 const codeOf=(reply:string)=>/Código: ([A-Z0-9]{4})/.exec(reply)![1];
 const count=async(sql:string,args:unknown[]=[])=>(await q(sql,args)).rows[0].n as number;
 const expenses=()=>count('SELECT count(*)::int n FROM appgastos.expenses');

 await t.test('subcategoría: se propone, no se crea hasta confirmar; confirmar dos veces no repite',async()=>{
  const r=await say(ANA,'Creá la subcategoría Verdulería dentro de Alimentación',{action:'create_category',name:'Verdulería',parent:'Alimentos y bebidas'});
  assert.match(r,/Voy a crear la subcategoría «Verdulería» dentro de «Alimentos y bebidas»/);assert.match(r,/confirmar/);
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name='Verdulería'"),0,'todavía no se creó');
  const code=codeOf(r);
  assert.match(await say(ANA,'confirmar'),/Creé la subcategoría «Verdulería»/);
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories c JOIN appgastos.categories p ON p.id=c.parent_id WHERE c.name='Verdulería' AND p.name='Alimentos y bebidas'"),1);
  assert.match(await say(ANA,'confirmar '+code),/ya estaba aplicada/);assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name='Verdulería'"),1);
  assert.equal((await pending()).length,0);
 });

 await t.test('presupuesto base y excepción por WhatsApp: recurrente, con confirmación',async()=>{
  const r=await say(ANA,'Poné $500.000 mensuales de presupuesto para Alimentación',{action:'set_budget',category:'Alimentos y bebidas',amount:'500000',amountText:'500.000'});
  assert.match(r,/fijar el presupuesto mensual de «Alimentos y bebidas» en \$500\.000/);
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.budget_bases'),0);
  await say(ANA,'sí');
  const month=async(m:string)=>(await json(await call('/api/budgets?month='+m,ana.token))).budgets.find((b:any)=>b.categoryId===alim);
  assert.equal((await month(cur)).amount,'500000.00');assert.equal((await month(addM(cur,4))).amount,'500000.00');
  // Importe que no coincide con el texto: no se acepta.
  assert.match(await say(ANA,'Cambiá el presupuesto de Alimentación a 300 mil',{action:'set_budget',category:'Alimentos y bebidas',amount:'900000',amountText:'300 mil'}),/¿De cuánto es\?/);
  assert.equal((await pending())[0].action.type,'collecting','queda esperando el importe');await say(ANA,'cancelar');assert.equal((await pending()).length,0);
  // Excepción de un mes: la base no cambia.
  const target=addM(cur,2);
  await say(ANA,'Para '+monthName(target)+' poné el presupuesto de Alimentación en 350 mil',{action:'set_budget_month',category:'Alimentos y bebidas',amount:'350000',amountText:'350 mil',monthText:monthName(target)});
  await say(ANA,'confirmar');
  assert.equal((await month(target)).amount,'350000.00');assert.equal((await month(target)).source,'exception');assert.equal((await month(addM(cur,3))).amount,'500000.00');
 });

 await t.test('gasto fijo nuevo: pregunta la categoría que falta y queda pendiente; "desde diciembre" cambia solo hacia adelante',async()=>{
  const r=await say(ANA,'Agregá el colegio como gasto fijo de $180.000, vence el día 10',{action:'create_fixed',name:'Colegio',amount:'180000',amountText:'180.000',dueDay:10});
  assert.match(r,/en qué categoría/);
  assert.match(await say(ANA,'confirmar'),/en qué categoría/,'no se puede confirmar sin la categoría');
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expenses'),0);
  assert.match(await say(ANA,'categoría Educación'),/categoría «Educación»/);
  assert.match(await say(ANA,'confirmar'),/Agregué el gasto fijo «Colegio» de \$180\.000, vence el día 10/);
  const f=(await q("SELECT id,expected_amount::text a FROM appgastos.fixed_expenses WHERE name='Colegio'")).rows[0];assert.equal(f.a,'180000.00');
  assert.equal((await json(await call('/api/control/summary?month='+cur,ana.token))).fixed.pending.amount,'180000.00','queda pendiente, no es un gasto');
  // Cambio de importe hacia adelante.
  const from=addM(cur,2);
  const r2=await say(ANA,'Desde '+monthName(from)+' el colegio cuesta $200.000',{action:'set_fixed_amount',fixed:'Colegio',amount:'200000',amountText:'200.000',monthText:monthName(from)});
  assert.match(r2,/cambiar el importe de «Colegio» a \$200\.000 desde/);await say(ANA,'confirmar');
  await call('/api/control/summary?month='+addM(cur,3),ana.token);
  const amounts=Object.fromEntries((await q("SELECT to_char(period,'YYYY-MM') m,expected_amount::text a FROM appgastos.fixed_expense_occurrences WHERE fixed_expense_id=$1",[f.id])).rows.map((r:any)=>[r.m,r.a]));
  assert.equal(amounts[cur],'180000.00');assert.equal(amounts[addM(cur,1)],'180000.00');assert.equal(amounts[from],'200000.00');
 });

 await t.test('"ya pagué el colegio": identifica la obligación, pide el medio, un solo gasto y no descuenta presupuesto variable; repetirlo no duplica',async()=>{
  await say(ANA,'ok',{});// sin pendientes: no hace nada
  const r=await say(ANA,'Ya pagué el colegio de '+monthName(cur),{action:'pay_fixed',fixed:'Colegio',monthText:monthName(cur)});
  assert.match(r,/registrar el pago de «Colegio» de .* por \$180\.000/);assert.match(r,/medio/);
  assert.equal(await expenses(),0);
  const code=codeOf(r);
  assert.match(await say(ANA,'confirmar'),/Antes decime con qué medio/);
  assert.match(await say(ANA,'transferencia'),/con transferencia/);
  assert.match(await say(ANA,'confirmar'),/Registré el pago de «Colegio»/);
  assert.equal(await expenses(),1);
  const e=(await q('SELECT scope,payment_method,amount::text a,category_id FROM appgastos.expenses')).rows[0];assert.deepEqual([e.scope,e.payment_method,e.a,e.category_id],['household','transfer','180000.00',edu]);
  assert.equal(await count('SELECT count(*)::int n FROM appgastos.fixed_expense_occurrences WHERE expense_id IS NOT NULL'),1);
  assert.match(await say(ANA,'confirmar '+code),/ya estaba aplicada/);assert.equal(await expenses(),1);
  // Pedir de nuevo el mismo pago: ya figura pagado, no registra otro.
  assert.match(await say(ANA,'Ya pagué el colegio de '+monthName(cur),{action:'pay_fixed',fixed:'Colegio',monthText:monthName(cur)}),/ya figura como pagado/);
  assert.equal(await expenses(),1);assert.equal((await pending()).length,0);
  const s=await json(await call('/api/control/summary?month='+cur,ana.token));
  assert.deepEqual([s.fixed.paid.amount,s.fixed.pending.count,s.variable.registered,s.totalSpent],['180000.00',0,'0.00','180000.00']);
 });

 await t.test('ambigüedad: varias obligaciones pendientes → pregunta de qué mes; no crea acción',async()=>{
  const f=(await q("SELECT id FROM appgastos.fixed_expenses WHERE name='Colegio'")).rows[0].id;
  await call('/api/control/summary?month='+addM(cur,1),ana.token);
  // El mes siguiente sigue pendiente; sin decir el mes, solo cuenta hasta el actual (ya pagado) → no hay pendiente "vencida o actual".
  assert.match(await say(ANA,'Ya pagué el colegio',{action:'pay_fixed',fixed:'Colegio'}),/No encontré una obligación pendiente/);
  await q('UPDATE appgastos.fixed_expenses SET start_date=$2 WHERE id=$1',[f,addM(cur,-2)+'-01']);await call('/api/control/summary?month='+cur,ana.token);
  const r=await say(ANA,'Ya pagué el colegio',{action:'pay_fixed',fixed:'Colegio'});
  assert.match(r,/varias pendientes/);assert.equal((await pending())[0].action.type,'collecting');await say(ANA,'cancelar');assert.equal((await pending()).length,0);assert.equal(await expenses(),1);
 });

 await t.test('roles: un integrante no configura ni confirma acciones del administrador, y no pasa por Gemini',async()=>{
  const before=calls.admin;
  const r=await say(BETO,'Creá la categoría Ocio',{action:'create_category',name:'Ocio'});
  assert.match(r,/solo para administradores/);assert.equal(calls.admin,before,'no se llamó al intérprete');
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name='Ocio'"),0);
  assert.equal((await q("SELECT outcome FROM appgastos.whatsapp_messages ORDER BY received_at DESC LIMIT 1")).rows[0].outcome,'admin_denied');
  // Una acción pendiente del administrador no la puede confirmar otro integrante ni con el código.
  const code=codeOf(await say(ANA,'Creá la categoría Salidas',{action:'create_category',name:'Salidas'}));
  await say(BETO,'confirmar '+code);
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name='Salidas'"),0);assert.equal((await pending()).length,1);
  // Cancelar descarta.
  assert.match(await say(ANA,'cancelar'),/no hice ningún cambio/);assert.equal((await pending()).length,0);
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name='Salidas'"),0);
 });

 await t.test('vencimiento y reemplazo: una acción vencida no se aplica; un pedido nuevo reemplaza al anterior',async()=>{
  await say(ANA,'Creá la categoría Viajes',{action:'create_category',name:'Viajes'});
  await q("UPDATE appgastos.admin_actions SET expires_at=now()-interval '1 minute' WHERE state='pending'");
  assert.match(await say(ANA,'confirmar'),/venció/);assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name='Viajes'"),0);
  await say(ANA,'Creá la categoría Plantas',{action:'create_category',name:'Plantas'});
  const r=await say(ANA,'Creá la categoría Souvenirs',{action:'create_category',name:'Souvenirs'});
  assert.match(r,/Dejé de lado tu pedido anterior/);assert.equal((await pending()).length,1);
  await say(ANA,'confirmar');
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.categories WHERE name IN ('Plantas','Souvenirs')"),1,'solo se aplica el último');
 });

 await t.test('errores de negocio al confirmar no dejan nada a medias; un gasto común no se confunde con configuración',async()=>{
  // La suma de subcategorías no puede superar el presupuesto del padre.
  await say(ANA,'Poné el presupuesto de Verdulería en 600 mil',{action:'set_budget',category:'Verdulería',amount:'600000',amountText:'600 mil'});
  assert.match(await say(ANA,'confirmar'),/No pude aplicarlo: La suma de las subcategorías/);
  assert.equal(await count("SELECT count(*)::int n FROM appgastos.budget_bases WHERE amount=600000"),0);assert.equal((await pending()).length,0);
  // Un gasto común: no llama al intérprete de administración y sigue el flujo normal.
  const before=calls.admin;
  app.interpret({amount:'5000',amountText:'5000',category:'Alimentos y bebidas',paymentMethod:'cash',paymentMethodText:'efectivo',description:'Compra'});
  assert.match(await say(ANA,'Gasté 5000 en el súper en efectivo'),/Registr/i);
  assert.equal(calls.admin,before);
  // Una frase de configuración que el modelo no reconoce como tal cae al flujo de gastos.
  const r=await say(ANA,'Poné 5000 de nafta en efectivo para la categoría',{action:'none'});
  assert.ok(r.length>0);assert.equal((await pending()).length,0);
 });

 await t.test('frase que arranca con el tema (sin verbo): es configuración, no un gasto; el integrante recibe la negativa',async()=>{
  const before=await expenses();
  const r=await say(ANA,'Presupuesto mascotas 250mil',{action:'set_budget',category:'Alimentos y bebidas',amount:'250000',amountText:'250mil'});
  assert.match(r,/Voy a fijar el presupuesto mensual de «Alimentos y bebidas» en \$250\.000/);
  assert.equal(await expenses(),before,'no se registró ningún gasto');
  await say(ANA,'cancelar');
  assert.match(await say(BETO,'Presupuesto mascotas 250mil'),/solo para administradores/);assert.equal(await expenses(),before);
 });

 await t.test('"Anota gasto fijo 100mil en el colegio": configuración (con cualquier verbo), no un gasto; el integrante recibe la negativa',async()=>{
  const before=await expenses();
  const r=await say(ANA,'Anota Gasto fijo 100mil en el colegio',{action:'create_fixed',name:'Academia',amount:'100000',amountText:'100mil',dueDay:10,category:'Educación'});
  assert.match(r,/Voy a agregar el gasto fijo «Academia» de \$100\.000/);assert.equal(await expenses(),before);
  await say(ANA,'cancelar');
  assert.match(await say(BETO,'Anota Gasto fijo 100mil en el colegio'),/solo para administradores/);assert.equal(await expenses(),before);
 });

 await t.test('conversación con memoria: "Registrar gasto fijo de 100000 en impuestos" → pregunta el día → "Vence el 10" completa el MISMO pedido (no es un gasto)',async()=>{
  const before=await expenses();
  const first=await say(ANA,'Registrar gasto fijo de 100000 en impuestos',{action:'create_fixed',name:'Impuestos',amount:'100000',amountText:'100000'});
  assert.match(first,/¿Qué día del mes vence\?/);assert.equal((await pending())[0].action.type,'collecting');
  // La respuesta corta no llama a Gemini ni cae en el flujo de gastos.
  const calls0=calls.admin;
  const second=await say(ANA,'Vence el 10');
  assert.equal(calls.admin,calls0);assert.match(second,/Voy a agregar el gasto fijo «Impuestos» de \$100\.000, vence el día 10, categoría «Impuestos & Seguros»/);
  assert.equal(await expenses(),before,'no se registró ningún gasto');
  assert.match(await say(ANA,'confirmar'),/Agregué el gasto fijo «Impuestos»/);
  assert.equal((await q("SELECT due_day FROM appgastos.fixed_expenses WHERE name='Impuestos'")).rows[0].due_day,10);
  // Una respuesta larga que repite todo el pedido también sirve (la interpreta Gemini).
  await say(ANA,'Registrar gasto fijo de 80000 en gimnasio',{action:'create_fixed',name:'Gimnasio',amount:'80000',amountText:'80000'});
  assert.match(await say(ANA,'80000 de gasto fijo en gimnasio vence el 5 de cada mes',{action:'create_fixed',name:'Gimnasio',amount:'80000',amountText:'80000',dueDay:5,category:'Educación'}),/Voy a agregar el gasto fijo «Gimnasio»/);
  await say(ANA,'cancelar');
 });

 await t.test('consultas: pendiente de gastos fijos y presupuesto restante (solo administradores)',async()=>{
  const r=await say(ANA,'¿Cuánto tengo pendiente de gastos fijos?');
  assert.match(r,/Gastos fijos de este mes: pagados \$180\.000/);assert.match(r,/Deudas de meses anteriores/);
  assert.match(await say(BETO,'¿Cuánto tengo pendiente de gastos fijos?'),/solo para administradores/);
  const left=await say(ANA,'¿Cuánto me queda del presupuesto de Alimentos y bebidas?');
  assert.match(left,/Alimentos y bebidas: presupuesto \$500\.000/);
  const sub=await say(ANA,'¿Cuánto queda del presupuesto de Verdulería?');
  assert.match(sub,/Verdulería no tiene presupuesto propio: cuenta dentro de Alimentos y bebidas/);
 });
});
