// Prueba del build con Chrome/Edge instalado. No requiere dependencias adicionales.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {isolatedDatabase,freePort,removeDirectory} from './helpers/postgres';
import {TEST_AUTH_ENV,TEST_AUTH_HEADER,apiFetch} from './helpers/auth';
import {migrate} from '../scripts/migrate';
import {seed} from '../scripts/seed';
import {enqueue} from '../src/backend/whatsapp/repository';
import {whatsappProcessor} from '../src/backend/whatsapp/processor';
import {emptyInterpretation,type Interpretation} from '../src/backend/whatsapp/candidate';

const delay = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check:()=>Promise<any>, message:string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(message);
}
test('Núcleo manual en navegador: gestión, filtros, CRUD y dashboard', { timeout: 180000 }, async () => {
  const browserPath = process.env.MANUAL_TEST_BROWSER || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  assert.ok(browserPath, 'Configura MANUAL_TEST_BROWSER con un Chrome/Edge instalado.');
  const db=await isolatedDatabase();
  await migrate(db.pool);await seed(db.pool);
  const profile = mkdtempSync(join(tmpdir(), 'appgastos-manual-test-'));
  const appPort = await freePort();
  const debugPort = await freePort();
  const startServer=()=>spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(appPort), NODE_ENV: 'production', ...TEST_AUTH_ENV, GEMINI_API_KEY: '', DATABASE_URL: db.url, APP_FAMILY_ID:'00000000-0000-4000-8000-000000000001', FRONTEND_DIST_DIR:'dist', TZ:'UTC' },
  });
  let server=startServer();
  let browser:ReturnType<typeof spawn>|undefined, ws!:WebSocket;
  const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}>();
  let sequence = 0;
  try {
    await waitFor(async () => (await apiFetch('http://127.0.0.1:' + appPort)).ok, 'El servidor no inició.');
    browser = spawn(browserPath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const target = await waitFor(async () => {
      const pages = await (await fetch('http://127.0.0.1:' + debugPort + '/json')).json();
      return pages.find((page:{type:string;webSocketDebuggerUrl:string}) => page.type === 'page');
    }, 'El navegador no inició.');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id)!; pending.delete(message.id);
        clearTimeout(entry.timeout);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      }
    });
    const command = (method:string, params:Record<string,unknown> = {}) => new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression:string) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const click = async (text:string) => {
      await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===' +
        JSON.stringify(text) + ');if(!b)throw new Error("No existe botón");b.click()})()');
      await delay(60);
    };
    const field = async (selector:string, value:string) => {
      await evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) +
        ');if(!el)throw new Error("No existe campo");Object.getOwnPropertyDescriptor(el.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(el,' +
        JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))})()');
      await delay(60);
    };


    await command('Page.enable');
    await command('Network.enable');await command('Network.setExtraHTTPHeaders',{headers:{Authorization:TEST_AUTH_HEADER}});
    const origin='http://127.0.0.1:'+appPort;
    await command('Page.navigate',{url:origin});
    await waitFor(()=>evaluate('document.body.textContent.includes("Sin gastos para este")'),'No cargó el inicio.');
    const button=async(selector:string)=>{
      await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(80);
    };
    const api=async(path:string)=>(await (await apiFetch(origin+'/api/'+path)).json());
    await click('Tarjetas e integrantes');
    await field('[aria-label="Nombre de tarjeta"]','Visa');
    await click('Crear tarjeta');
    await waitFor(async()=> (await api('cards')).cards.length===1,'No se creó la tarjeta.');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Editar tarjeta Visa"]\')'),'No se mostró la tarjeta.');
    const card=(await api('cards')).cards[0];
    await button('[aria-label="Editar tarjeta Visa"]');
    await field('[aria-label="Nombre de tarjeta"]','Visa familia');
    await click('Guardar tarjeta');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Editar tarjeta Visa familia"]\')'),'No se editó la tarjeta.');
    await field('[aria-label="Nombre de tarjeta"]','Débito');
    await click('Crear tarjeta');
    await waitFor(async()=> (await api('cards')).cards.length===2,'No se creó débito.');
    const alternateCard=(await api('cards')).cards.find((c:any)=>c.id!==card.id);
    await field('[aria-label="Nombre de integrante"]','Ana');
    await field('[aria-label="Teléfono del integrante"]','11 1111 2222');
    await click('Crear integrante');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Editar integrante Ana"]\')'),'No se creó Ana.');
    const member=(await api('family-members')).members[0];
    await button('[aria-label="Editar integrante Ana"]');
    await field('[aria-label="Nombre de integrante"]','Ana familia');
    await field('[aria-label="Teléfono del integrante"]','+54 11 3333 4444');
    await click('Guardar integrante');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Editar integrante Ana familia"]\')'),'No se editó Ana.');
    assert.equal((await api('family-members')).members.find((m:any)=>m.id===member.id).phoneNumber,'+54 11 3333 4444');
    await field('[aria-label="Nombre de integrante"]','Luis');
    await field('[aria-label="Teléfono del integrante"]','');
    await click('Crear integrante');
    await waitFor(async()=> (await api('family-members')).members.length===2,'No se creó Luis.');
    const alternateMember=(await api('family-members')).members.find((m:any)=>m.id!==member.id);
    await click('Panel Central');
    await click('Cargar Gasto');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Informado por"]\').value'),'');
    const categories=(await api('categories')).categories;
    const category=categories.find((c:any)=>c.name==='Supermercado'),otherCategory=categories.find((c:any)=>c.name==='Mascotas');
    await field('[aria-label="Descripción"]','Compra inicial');
    await field('[aria-label="Monto"]','40000');
    await field('[aria-label="Fecha"]','2026-10-08');
    await field('[aria-label="Comercio"]','Carrefour');
    await field('[aria-label="Categoría"]',category.id);
    await field('[aria-label="Medio de pago"]','credit_card');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').value'),'');
    await field('[aria-label="Tarjeta opcional"]',card.id);
    await field('[aria-label="Informado por"]',member.id);
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'No se guardó.');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    assert.ok((await evaluate('document.body.innerText')).includes('40.000,00'));
    const expense=(await api('expenses')).expenses[0];
    await click('Historial de Gastos');
    const rows=()=>evaluate('document.querySelectorAll("[data-expense-id]").length');
    assert.equal(await rows(),1);
    // Cada filtro positivo y negativo opera sobre el mismo gasto persistido.
    for(const [selector,match,noMatch] of [
      ['[aria-label="Filtrar por mes"]','2026-10','2026-09'],
      ['[aria-label="Filtrar por categoría de gasto"]',category.id,otherCategory.id],
      ['[aria-label="Filtrar por medio de pago"]','credit_card','cash'],
      ['[aria-label="Filtrar por tarjeta"]',card.id,alternateCard.id],
      ['[aria-label="Filtrar por miembro de la familia"]',member.id,alternateMember.id],
      ['[aria-label="Filtrar por comercio"]','carrefour','Kiosco']
    ]){
      await click('Limpiar filtros');await field(selector,match);assert.equal(await rows(),1,selector);
      await field(selector,noMatch);assert.equal(await rows(),0,selector);
    }
    await click('Limpiar filtros');
    await field('[aria-label="Filtrar por mes"]','2026-10');
    await field('[aria-label="Filtrar por medio de pago"]','credit_card');
    await field('[aria-label="Filtrar por tarjeta"]',card.id);
    await field('[aria-label="Filtrar por miembro de la familia"]',member.id);
    await field('[aria-label="Filtrar por comercio"]','Carrefour');
    assert.equal(await rows(),1);
    await click('Limpiar filtros');
    await click('Editar gasto');
    await field('[aria-label="Fecha"]','2026-09-11');
    await field('[aria-label="Monto"]','1234.56');
    await field('[aria-label="Moneda"]','USD');
    await field('[aria-label="Comercio"]','Veterinaria');
    await field('[aria-label="Descripción"]','Compra editada');
    await field('[aria-label="Categoría"]',otherCategory.id);
    await field('[aria-label="Medio de pago"]','debit_card');
    await field('[aria-label="Tarjeta opcional"]',alternateCard.id);
    await field('[aria-label="Informado por"]',alternateMember.id);
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'No terminó la edición.');
    const persisted=(await api('expenses/'+expense.id)).expense;
    assert.equal(persisted.amount,'1234.56');assert.equal(persisted.currency,'USD');assert.equal(persisted.date,'2026-09-11');
    assert.equal(persisted.description,'Compra editada');assert.equal(persisted.merchant,'Veterinaria');
    assert.equal(persisted.categoryId,otherCategory.id);assert.equal(persisted.paymentMethod,'debit_card');
    assert.equal(persisted.cardId,alternateCard.id);assert.equal(persisted.reportedByMemberId,alternateMember.id);
    await click('Panel Central');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    assert.ok((await evaluate('document.body.innerText')).includes('$ 0,00'));
    await field('[aria-label="Mes del dashboard"]','2026-09');
    await field('[aria-label="Moneda del dashboard"]','USD');
    assert.ok((await evaluate('document.body.innerText')).includes('1.234,56'));
    assert.ok((await evaluate('document.querySelector(\'[aria-label="Gastos por Categoría"]\').innerText')).includes('Mascotas'));
    assert.ok((await evaluate('document.querySelector(\'[aria-label="Gastos por Tarjeta"]\').innerText')).includes('Débito'));
    await field('[aria-label="Seleccionar miembro de la familia"]',alternateMember.id);
    await click('Tarjetas e integrantes');
    await button('[aria-label="Desactivar tarjeta Débito"]');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Activar tarjeta Débito"]\')'),'No se desactivó la tarjeta.');
    await button('[aria-label="Desactivar integrante Luis"]');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Activar integrante Luis"]\')'),'No se desactivó Luis.');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Seleccionar miembro de la familia"]\').value'),'');
    await click('Panel Central');await click('Cargar Gasto');
    await field('[aria-label="Medio de pago"]','credit_card');
    assert.equal(await evaluate('!![...document.querySelector(\'[aria-label="Tarjeta opcional"]\').options].find(o=>o.value==='+JSON.stringify(alternateCard.id)+')'),false);
    assert.equal(await evaluate('!![...document.querySelector(\'[aria-label="Informado por"]\').options].find(o=>o.value==='+JSON.stringify(alternateMember.id)+')'),false);
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').value'),'');
    await click('Cancelar');
    await click('Historial de Gastos');await click('Editar gasto');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').value'),alternateCard.id);
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Informado por"]\').value'),alternateMember.id);
    await field('[aria-label="Descripción"]','Historia conservada');
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'No conservó referencias históricas.');
    await command('Page.reload');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Mes del dashboard"]\')&&!document.querySelector("[role=alert]")'),'No recargó.');
    await click('Historial de Gastos');
    await waitFor(rows,'No persistió el gasto.');
    assert.ok((await evaluate('document.body.innerText')).includes('Historia conservada'));
    // Persistencia al reiniciar Express con la misma base temporal.
    const exited=new Promise<void>(r=>server.once('exit',()=>r()));server.kill();await exited;server=startServer();
    await waitFor(async()=> (await apiFetch(origin+'/api/expenses/'+expense.id)).ok,'No reinició.');
    assert.equal((await api('expenses/'+expense.id)).expense.reportedByMemberId,alternateMember.id);
    await command('Page.reload');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Mes del dashboard"]\')&&!document.querySelector("[role=alert]")'),'No cargó después del reinicio.');
    await click('Historial de Gastos');await waitFor(rows,'No mostró el historial.');
    // Error al borrar no remueve el gasto del estado.
    await command('Network.enable');
    await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await button('[title="Eliminar gasto"]');
    await waitFor(()=>evaluate('!!document.querySelector("[role=alert]")'),'No mostró el error de eliminación.');
    assert.equal(await rows(),1);
    await command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await button('[title="Eliminar gasto"]');
    await waitFor(async()=> (await api('expenses')).expenses.length===0,'No se eliminó.');
    await waitFor(async()=> (await rows())===0,'No se actualizó el historial.');
    await click('Panel Central');
    assert.ok((await evaluate('document.body.innerText')).includes('$ 0,00'));
    assert.equal((await api('cards')).cards.length,2);assert.equal((await api('family-members')).members.length,2);
    // Un informante null se conserva al editar, incluso con otro activo en navbar.
    await field('[aria-label="Seleccionar miembro de la familia"]',member.id);
    await click('Cargar Gasto');
    await field('[aria-label="Descripción"]','Sin informante');
    await field('[aria-label="Monto"]','1');
    await field('[aria-label="Fecha"]','2026-10-08');
    await field('[aria-label="Categoría"]',category.id);
    await field('[aria-label="Medio de pago"]','cash');
    await field('[aria-label="Informado por"]','');
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'No se guardó el gasto sin informante.');
    assert.equal((await api('expenses')).expenses[0].reportedByMemberId,null);
    await click('Historial de Gastos');await click('Editar gasto');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Informado por"]\').value'),'');
    await click('Cancelar');

    // External WhatsApp expense appears through polling, without reloading the page.
    const sender='5491144445555';
    await db.pool.query('UPDATE appgastos.family_members SET phone_number=$2 WHERE id=$1',[member.id,sender]);
    const proc=whatsappProcessor(db.pool,async()=>({
      amount:'1234.56',amountText:'1234.56',dateText:'2026-10-08',currency:null,currencyText:null,
      merchant:'Carrefour',description:'Compra WhatsApp',category:'Supermercado',paymentMethod:'cash',paymentMethodText:'efectivo',card:null,
    }),async()=>{});
    await enqueue(db.pool,'00000000-0000-4000-8000-000000000001',[{id:'browser-whatsapp',sender,text:'Gasté 1234.56 en Carrefour efectivo el 2026-10-08',type:'text',receivedAt:new Date()}]);
    await proc.processNext();await proc.replyNext();
    await waitFor(async()=>(await rows())===2,'El gasto WhatsApp no apareció automáticamente en Historial.');
    assert.ok((await evaluate('document.body.innerText')).includes('Compra WhatsApp'));
    await click('Panel Central');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    await field('[aria-label="Moneda del dashboard"]','ARS');
    assert.ok((await evaluate('document.body.innerText')).includes('1.235,56'));
    assert.ok((await evaluate('document.querySelector(\'[aria-label="Gastos por Categoría"]\').innerText')).includes('1.235,56'));
    // Gasto completado en varios mensajes de una conversación: Dashboard, categoría, tarjeta e Historial.
    const answers:Record<string,Partial<Interpretation>>={'Compré en Disco':{merchant:'Disco',description:'Compra en Disco',category:'Supermercado'}};
    const conversational=whatsappProcessor(db.pool,async(ctx)=>({...emptyInterpretation(),...answers[ctx.text]}),async()=>{});
    let step=0;
    for(const text of ['Compré en Disco','500','crédito','Visa familia']){
      step++;
      await enqueue(db.pool,'00000000-0000-4000-8000-000000000001',[{id:'browser-conversation-'+step,sender,text,type:'text',receivedAt:new Date(),metaTimestamp:new Date(Date.parse('2026-10-08T15:00:00Z')+step*1000)}]);
      await conversational.processNext();await conversational.replyNext();
    }
    const registered=(await db.pool.query("SELECT outcome,expense_id FROM appgastos.whatsapp_messages WHERE message_id='browser-conversation-4'")).rows[0];
    assert.equal(registered.outcome,'registered');
    await waitFor(async()=>(await evaluate('document.body.innerText')).includes('1.735,56'),'El gasto conversacional no apareció en el Dashboard.');
    assert.ok((await evaluate('document.querySelector(\'[aria-label="Gastos por Categoría"]\').innerText')).includes('1.735,56'));
    assert.ok((await evaluate('document.querySelector(\'[aria-label="Gastos por Tarjeta"]\').innerText')).includes('Visa familia'));
    await click('Historial de Gastos');
    await waitFor(async()=>(await rows())===3,'El gasto conversacional no apareció en Historial.');
    assert.ok((await evaluate('document.body.innerText')).includes('Compra en Disco'));
    await command('Browser.close');
  } finally {
    ws?.close();
    for (const entry of pending.values()) {clearTimeout(entry.timeout);entry.reject(new Error('Prueba terminada'));}
    browser?.kill();server.kill();await db.stop();await delay(300);removeDirectory(profile);
  }
});
