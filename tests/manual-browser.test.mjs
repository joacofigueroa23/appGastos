// Prueba del build con Chrome/Edge instalado. No requiere dependencias adicionales.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(message);
}
test('carga manual en navegador: persistencia, selección, errores y métricas', { timeout: 60000 }, async () => {
  const browserPath = process.env.MANUAL_TEST_BROWSER || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  assert.ok(browserPath, 'Configura MANUAL_TEST_BROWSER con un Chrome/Edge instalado.');
  const profile = mkdtempSync(join(tmpdir(), 'appgastos-manual-test-'));
  const appPort = 3187;
  const debugPort = 9287;
  const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(appPort), NODE_ENV: 'production', GEMINI_API_KEY: '', DATABASE_URL: '', FRONTEND_DIST_DIR: 'dist-demo', VITE_ENABLE_DEMO: 'true' },
  });
  let browser, ws;
  const pending = new Map();
  let sequence = 0;
  try {
    await waitFor(async () => (await fetch('http://127.0.0.1:' + appPort)).ok, 'El servidor no inició.');
    browser = spawn(browserPath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const target = await waitFor(async () => {
      const pages = await (await fetch('http://127.0.0.1:' + debugPort + '/json')).json();
      return pages.find((page) => page.type === 'page');
    }, 'El navegador no inició.');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id);
        clearTimeout(entry.timeout);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      }
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const click = async (text) => {
      await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===' +
        JSON.stringify(text) + ');if(!b)throw new Error("No existe botón");b.click()})()');
      await delay(60);
    };
    const field = async (selector, value) => {
      await evaluate('(()=>{const el=document.querySelector(' + JSON.stringify(selector) +
        ');if(!el)throw new Error("No existe campo");Object.getOwnPropertyDescriptor(el.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(el,' +
        JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))})()');
      await delay(60);
    };
    await command('Page.enable');
    await command('Emulation.setTimezoneOverride', { timezoneId: 'America/Argentina/Buenos_Aires' });
    await command('Page.navigate', { url: 'http://127.0.0.1:' + appPort });
    await waitFor(() => evaluate('document.body.textContent.includes("Control de Gastos")'), 'No cargó React.');
    await evaluate('localStorage.setItem("gf_expenses","[]")');
    await command('Page.reload');
    await waitFor(() => evaluate('document.body.textContent.includes("Control de Gastos")'), 'No recargó React.');

    const fillManual = async (description, amount = '1234.56', date = '2026-10-08') => {
      await click('Cargar Gasto');
      await field('form input[type="text"]', description);
      await field('form input[type="number"]', amount);
      await field('form input[type="date"]', date);
      await field('select[aria-label="Categoría"]', 'Mascotas');
      await field('select[aria-label="Medio de pago"]', 'Tarjeta de Crédito');
    };
    await fillManual('Sin tarjeta');
    assert.equal(await evaluate('document.querySelector("select[aria-label=\\"Tarjeta opcional\\"]").value'), '');
    await click('Guardar Gasto');
    let stored = await evaluate('JSON.parse(localStorage.getItem("gf_expenses"))');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].amount, 1234.56);
    assert.equal(stored[0].date, '2026-10-08');
    assert.equal(stored[0].cardId, undefined);
    assert.equal(stored[0].currency, 'ARS');
    assert.ok(stored[0].reportedByMemberId);
    assert.equal(stored[0].isShared, true);

    await fillManual('Tarjeta elegida', '99.99');
    const selected = await evaluate('document.querySelector("select[aria-label=\\"Tarjeta opcional\\"]").options[2].value');
    await field('select[aria-label="Tarjeta opcional"]', selected);
    await click('Guardar Gasto');
    stored = await evaluate('JSON.parse(localStorage.getItem("gf_expenses"))');
    assert.equal(stored[0].cardId, selected);
    assert.equal(stored[0].amount, 99.99);
    await command('Page.reload');
    await waitFor(() => evaluate('document.body.textContent.includes("Control de Gastos")'), 'No recargó.');
    assert.equal((await evaluate('JSON.parse(localStorage.getItem("gf_expenses"))')).length, 2);
    await fillManual('Después de recargar');
    assert.equal(await evaluate('document.querySelector("select[aria-label=\\"Tarjeta opcional\\"]").value'), '');

    await evaluate('window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==="gf_expenses")throw new DOMException("Sin espacio","QuotaExceededError");return window.originalSetItem.call(this,k,v)}');
    await click('Guardar Gasto');
    assert.ok(await evaluate('document.querySelector("[role=alert]").textContent.includes("No se pudo guardar")'));
    assert.equal(await evaluate('document.querySelector("form input[type=number]").value'), '1234.56');
    assert.equal((await evaluate('JSON.parse(localStorage.getItem("gf_expenses"))')).length, 2);
    await evaluate('Storage.prototype.setItem=window.originalSetItem');
    await click('Cancelar');

    // Datos mixtos deliberados en perfil aislado para verificar el dashboard real.
    await evaluate('(()=>{const now=new Date();const month=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");const base=JSON.parse(localStorage.getItem("gf_expenses"))[0];localStorage.setItem("gf_expenses",JSON.stringify([{...base,id:"ars",date:month+"-08",amount:1234.56,currency:"ARS",category:"Mascotas"},{...base,id:"old",date:"2000-01-01",amount:900000,currency:"ARS"},{...base,id:"usd",date:month+"-08",amount:100,currency:"USD"}]))})()');
    await command('Page.reload');
    await waitFor(() => evaluate('document.body.textContent.includes("Control de Gastos")'), 'No cargó dashboard.');
    const panel = await evaluate('document.body.textContent');
    assert.ok(panel.includes('1.234,56'));
    assert.ok(panel.includes('(100%)'));
    assert.ok(!panel.includes('900.000'));
    await click('Historial de Gastos');
    const history = await evaluate('document.body.textContent');
    assert.ok(history.includes('ARS:'));
    assert.ok(history.includes('USD:'));
    assert.equal(await evaluate('document.querySelector("select[aria-label=\\"Filtrar por categoría de gasto\\"]").options.length'), 13);

    // La API de IA sin credenciales debe fallar, nunca devolver monto ficticio.
    const ai = await fetch('http://127.0.0.1:' + appPort + '/api/gemini/parse-expense', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Compré algo' }),
    });
    assert.equal(ai.status, 500);
    assert.equal((await ai.json()).success, undefined);
    await command('Browser.close');
    console.log('Verificado en Chrome/Edge: monto, fecha, tarjetas, recarga, fallo de guardado, períodos, monedas, categorías y fallback sin Gemini.');
  } finally {
    ws?.close();
    for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('Prueba terminada')); }
    browser?.kill();
    server.kill();
    // Se conserva el perfil temporal para diagnóstico; no se toca el navegador del usuario.
  }
});
