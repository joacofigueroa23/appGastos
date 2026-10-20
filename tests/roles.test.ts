import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sessionApp} from './helpers/sessionApp';
import {memberAccount} from '../scripts/member-account';
import {actorOf} from '../src/backend/accounts/policy';

test('Roles: administración, último administrador, permisos inmediatos y ámbito del gasto',async(t)=>{
 const app=await sessionApp();
 const {q,call,json}=app;
 t.after(()=>app.stop());
 const ana=await app.account('ana',{role:'admin'}),beto=await app.account('beto'),carla=await app.account('carla'),inactivo=await app.account('inactivo',{active:false});
 const sinCuenta=(await q("INSERT INTO appgastos.family_members(family_id,name) VALUES('00000000-0000-4000-8000-000000000001','SinCuenta') RETURNING id")).rows[0].id as string;
 const compras=await app.category('Compras');
 const role=(token:string,id:string,value:unknown)=>call('/api/family-members/'+id+'/role',token,'PATCH',{role:value});
 const roleOf=async(id:string)=>(await q('SELECT role FROM appgastos.family_members WHERE id=$1',[id])).rows[0].role;

 await t.test('un integrante no puede promoverse ni promover a otro; el cliente no define el rol',async()=>{
  assert.equal((await role(beto.token,beto.id,'admin')).status,403);
  assert.equal((await role(beto.token,carla.id,'admin')).status,403);
  assert.equal(await roleOf(beto.id),'member');
  // Un rol enviado en otros campos se ignora o se rechaza: nunca otorga privilegios.
  assert.equal((await call('/api/family-members/'+beto.id,beto.token,'PATCH',{role:'admin'})).status,403);
  assert.equal((await call('/api/family-members/'+beto.id,ana.token,'PATCH',{role:'admin'})).status,400);
  assert.equal(await roleOf(beto.id),'member');
  assert.equal((await role('tok-inexistente',beto.id,'admin')).status,401);
 });
 await t.test('el administrador promueve con validaciones y queda auditado',async()=>{
  assert.equal((await role(ana.token,beto.id,'jefe')).status,400);
  assert.equal((await role(ana.token,randomUUID(),'admin')).status,404);
  assert.equal((await role(ana.token,inactivo.id,'admin')).status,409);
  assert.equal((await role(ana.token,sinCuenta,'admin')).status,409);
  assert.equal((await role(ana.token,beto.id,'admin')).status,200);
  const row=(await q('SELECT role,role_changed_by_member_id,role_changed_at FROM appgastos.family_members WHERE id=$1',[beto.id])).rows[0];
  assert.equal(row.role,'admin');assert.equal(row.role_changed_by_member_id,ana.id);assert.ok(row.role_changed_at);
  assert.equal((await role(ana.token,beto.id,'admin')).status,200);
  assert.ok((await json(await call('/api/family-members',ana.token))).members.every((m:any)=>['admin','member'].includes(m.role)));
 });
 await t.test('el último administrador activo no se degrada ni se desactiva',async()=>{
  assert.equal((await role(ana.token,ana.id,'member')).status,200);
  assert.equal(await roleOf(ana.id),'member');
  assert.equal((await role(beto.token,beto.id,'member')).status,409);
  assert.equal((await call('/api/family-members/'+beto.id,beto.token,'PATCH',{active:false})).status,409);
  assert.equal(await roleOf(beto.id),'admin');
  // La base lo garantiza aunque se salte la API (comando de administración).
  await assert.rejects(memberAccount(app.db.pool,'deactivate',beto.id),/last_admin/);
  await assert.rejects(memberAccount(app.db.pool,'set-role',beto.id,'member'),/administrador activo/);
 });
 await t.test('dos administradores que se degradan a la vez: siempre queda uno',async()=>{
  assert.equal((await role(beto.token,ana.id,'admin')).status,200);
  const results=await Promise.all([role(ana.token,beto.id,'member'),role(beto.token,ana.id,'member')]);
  const ok=results.filter(r=>r.status===200).length;
  assert.equal(ok,1,'exactamente uno gana');
  assert.equal((await q("SELECT count(*)::int n FROM appgastos.family_members WHERE role='admin' AND active")).rows[0].n,1);
  await role(ana.token,beto.id,'admin').catch(()=>{});
  await q("UPDATE appgastos.family_members SET role='admin' WHERE id IN ($1,$2)",[ana.id,beto.id]);
 });
 await t.test('los permisos cambian al instante: el rol se lee de la base en cada pedido',async()=>{
  assert.equal((await app.expense(carla.token,compras,{description:'De Carla'})).status,201);
  assert.equal((await app.expense(ana.token,compras,{description:'De Ana'})).status,201);
  assert.equal((await json(await call('/api/expenses',beto.token))).expenses.length,2);
  await q("UPDATE appgastos.family_members SET role='member' WHERE id=$1",[beto.id]);
  assert.equal((await json(await call('/api/expenses',beto.token))).expenses.length,0);
  assert.equal((await role(beto.token,carla.id,'admin')).status,403);
  await q("UPDATE appgastos.family_members SET role='admin' WHERE id=$1",[beto.id]);
 });
 await t.test('sesión revocada o integrante desactivado pierden acceso aunque conserven el token',async()=>{
  const dani=await app.account('dani');
  assert.equal((await call('/api/expenses',dani.token)).status,200);
  await q('UPDATE appgastos.family_members SET active=false WHERE id=$1',[dani.id]);
  assert.equal((await call('/api/expenses',dani.token)).status,403);
  await q('UPDATE appgastos.family_members SET active=true WHERE id=$1',[dani.id]);
  app.revoke(dani.token);
  assert.equal((await call('/api/expenses',dani.token)).status,401);
 });
 await t.test('primer administrador por comando: requiere cuenta y un id explícito',async()=>{
  const nueva=(await q("INSERT INTO appgastos.families(name) VALUES('Otra') RETURNING id")).rows[0].id;
  assert.ok(nueva);
  await assert.rejects(memberAccount(app.db.pool,'set-role',sinCuenta,'admin'),/cuenta/);
  await assert.rejects(memberAccount(app.db.pool,'set-role','no-es-uuid','admin'),/UUID/);
  assert.match(await memberAccount(app.db.pool,'set-role',carla.id,'admin'),/ahora es admin/);
  assert.match(await memberAccount(app.db.pool,'set-role',carla.id,'member'),/ahora es member/);
 });

 // ---- 1D-a: ámbito personal / de la casa
 const histórico=(await q("INSERT INTO appgastos.expenses(family_id,date,amount,currency,description,category_id,payment_method) VALUES('00000000-0000-4000-8000-000000000001','2026-09-02',180000,'ARS','Cuota del colegio',$1,'cash') RETURNING id",[compras])).rows[0].id as string;
 await t.test('ámbito: personal por defecto, casa si se indica, histórico sin clasificar y no inferido',async()=>{
  const personal=await json(await app.expense(carla.token,compras));
  assert.equal(personal.expense.scope,'personal');
  const casa=await json(await app.expense(carla.token,compras,{scope:'household',description:'Cuota del colegio'}));
  assert.equal(casa.expense.scope,'household');assert.equal(casa.expense.reportedByMemberId,carla.id);
  assert.equal((await app.expense(carla.token,compras,{scope:'familia'})).status,400);
  // El histórico con descripción "Cuota del colegio" no se clasificó solo.
  assert.equal((await q('SELECT scope FROM appgastos.expenses WHERE id=$1',[histórico])).rows[0].scope,null);
  const sin=await json(await call('/api/expenses?scope=none',ana.token));
  assert.deepEqual(sin.expenses.map((e:any)=>e.id),[histórico]);
  // El integrante no lo ve; el administrador lo clasifica sin cambiar su autor (sin autor).
  assert.equal((await call('/api/expenses/'+histórico,carla.token)).status,404);
  const classified=await json(await call('/api/expenses/'+histórico,ana.token,'PATCH',{scope:'household'}));
  assert.equal(classified.expense.scope,'household');assert.equal(classified.expense.reportedByMemberId,null);
  assert.equal((await json(await call('/api/expenses?scope=none',ana.token))).expenses.length,0);
  // Editar otro campo no pierde el ámbito.
  const edited=await json(await call('/api/expenses/'+casa.expense.id,carla.token,'PATCH',{amount:'2000'}));
  assert.equal(edited.expense.scope,'household');
  // El integrante filtra por ámbito solo dentro de lo suyo.
  const mine=await json(await call('/api/expenses?scope=household',carla.token));
  assert.deepEqual(mine.expenses.map((e:any)=>e.id),[casa.expense.id]);
 });
});

test('Sin integrante resuelto: con sesión individual activa no hay acceso de administrador por omisión',()=>{
 assert.deepEqual(actorOf({locals:{}}),{role:'admin',memberId:null},'Basic Auth: credencial compartida = administrador');
 assert.throws(()=>actorOf({locals:{},app:{locals:{requireSession:true}}}),/Iniciá sesión/);
 assert.deepEqual(actorOf({locals:{member:{id:'m',role:'member'}},app:{locals:{requireSession:true}}}),{role:'member',memberId:'m'});
});
