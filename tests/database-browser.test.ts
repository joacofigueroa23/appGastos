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

const delay = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check:()=>Promise<any>, message:string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(message);
}
test('PostgreSQL en navegador: Carrefour, edición, recarga, reinicio y error de red', { timeout: 120000 }, async () => {
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
    await command('Emulation.setTimezoneOverride',{timezoneId:'America/Argentina/Buenos_Aires'});
    const origin='http://127.0.0.1:'+appPort;
    await command('Page.navigate',{url:origin});
    await waitFor(()=>evaluate('document.body.textContent.includes("Sin gastos para este")'),'No cargó la base vacía.');
    assert.equal(await evaluate('!![...document.querySelectorAll("header button")].find(b=>b.textContent.includes("+ Gasto"))'),false);
    const marker='[{"id":"local-no-migrar","amount":999999}]';
    await evaluate('localStorage.setItem("gf_expenses",'+JSON.stringify(marker)+')');
    await command('Page.reload');
    await waitFor(()=>evaluate('document.body.textContent.includes("Sin gastos para este")'),'LocalStorage no debe poblar PostgreSQL.');
    assert.equal((await (await apiFetch(origin+'/api/expenses')).json()).expenses.length,0);
    const categories=(await (await apiFetch(origin+'/api/categories')).json()).categories;
    const supermarket=categories.find((c:{id:string;name:string})=>c.name==='Supermercado');
    assert.ok(supermarket);
    await click('Cargar Gasto');
    await field('[aria-label="Descripción"]','Compra familiar');
    await field('[aria-label="Monto"]','40000');
    await field('[aria-label="Fecha"]','2026-10-08');
    await field('[aria-label="Comercio"]','Carrefour');
    await field('[aria-label="Categoría"]',supermarket.id);
    await field('[aria-label="Medio de pago"]','credit_card');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').value'),'');
    await field('[aria-label="Nombre de nueva tarjeta"]','Visa');
    await click('Agregar tarjeta');
    await waitFor(()=>evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').options.length===2'),'No se creó Visa.');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').value'),'');
    const chosen=await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').options[1].value');
    await field('[aria-label="Tarjeta opcional"]',chosen);
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'No se guardó.');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    assert.ok((await evaluate('document.body.textContent')).includes('40.000,00'));
    assert.ok((await evaluate('document.body.textContent')).includes('Visa'));
    let records=(await (await apiFetch(origin+'/api/expenses')).json()).expenses;
    assert.equal(records.length,1);assert.equal(records[0].amount,'40000.00');
    assert.equal(records[0].date,'2026-10-08');assert.equal(records[0].cardId,chosen);
    assert.equal(records[0].merchant,'Carrefour');assert.equal(records[0].source,'manual');
    const id=records[0].id;
    await click('Historial de Gastos');
    assert.ok((await evaluate('document.body.textContent')).includes('Carrefour'));
    await click('Editar gasto');
    await field('[aria-label="Monto"]','1234.56');
    await click('Guardar Gasto');
    await waitFor(async()=>((await (await apiFetch(origin+'/api/expenses/'+id)).json()).expense.amount==='1234.56'),'No se editó.');
    await command('Page.reload');
    await waitFor(()=>evaluate('document.body.textContent.includes("1.234,56")'),'No persistió después de recargar.');
    await command('Emulation.setTimezoneOverride',{timezoneId:'Pacific/Honolulu'});
    await click('Historial de Gastos');await click('Editar gasto');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Fecha"]\').value'),'2026-10-08');
    await click('Cancelar');
    // Reiniciar Express conserva el mismo PostgreSQL temporal.
    server.kill();await new Promise(r=>server.once('exit',r));server=startServer();
    await waitFor(async()=> (await apiFetch(origin+'/api/expenses/'+id)).ok,'No reinició Express.');
    assert.equal((await (await apiFetch(origin+'/api/expenses/'+id)).json()).expense.amount,'1234.56');
    // Una moneda y un mes diferentes no alteran las métricas ARS de octubre.
    const input={date:'2026-10-08',amount:'100',currency:'USD',merchant:null,description:'USD separado',categoryId:supermarket.id,paymentMethod:'cash',cardId:null,reportedByMemberId:null};
    await apiFetch(origin+'/api/expenses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    await apiFetch(origin+'/api/expenses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,currency:'ARS',date:'2000-01-01',amount:'900000'})});
    await command('Page.reload');
    await waitFor(()=>evaluate('document.body.textContent.includes("Mes")'),'No cargó dashboard.');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    const panel=await evaluate('document.body.textContent');
    assert.ok(panel.includes('1.234,56'));assert.ok(!panel.includes('900.000'));assert.ok(!panel.includes('USD separado'));
    // Solo crédito/débito entran en tarjetas: ni efectivo ni billeteras.
    for(const entry of [
      {...input,currency:'ARS',amount:'10.25',description:'Efectivo separado'},
      {...input,currency:'ARS',paymentMethod:'wallet',amount:'70.50',description:'Billetera separada'},
      {...input,currency:'ARS',paymentMethod:'debit_card',amount:'2.25',description:'Tarjeta sin especificar'}
    ]) {
      const response=await apiFetch(origin+'/api/expenses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(entry)});
      assert.equal(response.status,201);
    }
    await command('Page.reload');
    await waitFor(()=>evaluate('document.body.textContent.includes("1.317,56")'),'No cargaron los totales separados.');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    const cardsPanel=await evaluate('document.querySelector(\'[aria-label="Gastos por Tarjeta"]\').innerText');
    assert.ok(cardsPanel.includes('1.234,56'));
    assert.ok(cardsPanel.includes('Sin tarjeta especificada'));
    assert.ok(cardsPanel.includes('2,25'));
    assert.ok(!cardsPanel.includes('70,50'));
    assert.ok(!cardsPanel.includes('10,25'));
    const cashPanel=await evaluate('document.querySelector(\'[aria-label="Gastos en Efectivo"]\').innerText');
    assert.ok(cashPanel.includes('10,25'));
    assert.ok(!cashPanel.includes('70,50'));
    assert.ok(!cashPanel.includes('1.234,56'));
    // Sin conexión el formulario conserva el dato y no guarda en localStorage.
    await click('Cargar Gasto');
    await field('[aria-label="Descripción"]','Error de red');
    await field('[aria-label="Monto"]','42.42');
    await field('[aria-label="Categoría"]',supermarket.id);
    await field('[aria-label="Medio de pago"]','credit_card');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Tarjeta opcional"]\').value'),'');
    await command('Network.enable');
    await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!!document.querySelector("[role=alert]")'),'No se mostró error de red.');
    assert.equal(await evaluate('document.querySelector(\'[aria-label="Monto"]\').value'),'42.42');
    assert.equal(await evaluate('localStorage.getItem("gf_expenses")'),marker);
    await command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    assert.equal((await (await apiFetch(origin+'/api/expenses')).json()).expenses.length,6);
    await click('Cancelar');
    await command('Browser.close');
  } finally {
    ws?.close();
    for(const entry of pending.values()){clearTimeout(entry.timeout);entry.reject(new Error('Prueba terminada'));}
    browser?.kill();server.kill();await db.stop();await delay(300);removeDirectory(profile);
  }
});
