// Sesión individual en el navegador real: login, autoría en la web, perfil y vinculación de WhatsApp.
// Supabase se reemplaza por un servidor local que habla el mismo protocolo (no se usa ningún proyecto real).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {isolatedDatabase,freePort,removeDirectory} from './helpers/postgres';
import {migrate} from '../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../scripts/seed';
import {transaction} from '../src/backend/expenses/repository';
import {attemptLink} from '../src/backend/accounts/linking';

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check:()=>Promise<any>,message:string){
  const end=Date.now()+15000;
  while(Date.now()<end){try{const v=await check();if(v)return v;}catch{}await delay(100);}
  throw new Error(message);
}
test('Sesión individual en el navegador: login, autor del gasto y vinculación de WhatsApp',{timeout:180000},async()=>{
  const browserPath=process.env.MANUAL_TEST_BROWSER||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  assert.ok(browserPath,'Configura MANUAL_TEST_BROWSER con un Chrome/Edge instalado.');
  const db=await isolatedDatabase();await migrate(db.pool);await seed(db.pool);
  const ana=randomUUID(),ghost=randomUUID(),boss=randomUUID();
  const users:Record<string,{id:string;email:string}>={'ana@familia.test':{id:ana,email:'ana@familia.test'},'ghost@familia.test':{id:ghost,email:'ghost@familia.test'},'jefa@familia.test':{id:boss,email:'jefa@familia.test'}};
  const sessions:Record<string,string>={};
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'};
  const supabase=createServer((req,res)=>{
    if(req.method==='OPTIONS')return void res.writeHead(204,cors).end();
    const send=(status:number,body:unknown)=>res.writeHead(status,{...cors,'Content-Type':'application/json'}).end(JSON.stringify(body));
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const url=new URL(req.url!,'http://x');
      if(url.pathname==='/auth/v1/token'&&req.method==='POST'){
        const {email,password}=JSON.parse(raw||'{}'),user=users[email];
        if(!user||password!=='clave-ok')return send(400,{error:'invalid_grant',error_description:'Invalid login credentials',code:400,msg:'Invalid login credentials'});
        const token='tok-'+user.id;sessions[token]=user.id;
        return send(200,{access_token:token,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'r-'+user.id,user:{id:user.id,aud:'authenticated',role:'authenticated',email:user.email,app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}});
      }
      if(url.pathname==='/auth/v1/user'){
        const id=sessions[(req.headers.authorization||'').replace('Bearer ','')];
        const user=Object.values(users).find(u=>u.id===id);
        return user?send(200,{id:user.id,email:user.email,aud:'authenticated'}):send(401,{msg:'invalid JWT'});
      }
      if(url.pathname==='/auth/v1/logout')return void res.writeHead(204,cors).end();
      send(404,{});
    });
  });
  await new Promise<void>(r=>supabase.listen(0,'127.0.0.1',r));
  const supabaseUrl='http://127.0.0.1:'+(supabase.address() as any).port;
  const member=(await db.pool.query("INSERT INTO appgastos.family_members(family_id,name,auth_user_id) VALUES($1,'Ana',$2) RETURNING id",[INITIAL_FAMILY_ID,ana])).rows[0].id as string;
  await db.pool.query("INSERT INTO appgastos.family_members(family_id,name,auth_user_id,role) VALUES($1,'Jefa',$2,'admin')",[INITIAL_FAMILY_ID,boss]);
  const category=(await db.pool.query("INSERT INTO appgastos.categories(family_id,name) VALUES($1,'Compras') RETURNING id",[INITIAL_FAMILY_ID])).rows[0].id as string;
  const profile=mkdtempSync(join(tmpdir(),'appgastos-session-test-'));
  const appPort=await freePort(),debugPort=await freePort();
  // Sin APP_AUTH_*: con Supabase configurado no hay Basic Auth y el navegador no envía credenciales por su cuenta.
  const server=spawn(process.execPath,['--import','tsx','server.ts'],{windowsHide:true,stdio:'ignore',
    env:{...process.env,PORT:String(appPort),NODE_ENV:'production',APP_AUTH_USER:'',APP_AUTH_PASSWORD:'',SUPABASE_URL:supabaseUrl,SUPABASE_ANON_KEY:'anon-public-key',GEMINI_API_KEY:'',DATABASE_URL:db.url,APP_FAMILY_ID:INITIAL_FAMILY_ID,FRONTEND_DIST_DIR:'dist',TZ:'UTC'}});
  let browser:ReturnType<typeof spawn>|undefined,ws!:WebSocket;
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timeout:ReturnType<typeof setTimeout>}>();
  let sequence=0;
  try{
    const origin='http://127.0.0.1:'+appPort;
    await waitFor(async()=>(await fetch(origin+'/api/auth/config')).ok,'El servidor no inició.');
    // La web se sirve sin clave; la API exige sesión.
    assert.equal((await fetch(origin+'/')).status,200);
    assert.equal((await fetch(origin+'/api/expenses')).status,401);
    browser=spawn(browserPath!,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const target=await waitFor(async()=>(await (await fetch('http://127.0.0.1:'+debugPort+'/json')).json()).find((p:{type:string})=>p.type==='page'),'El navegador no inició.');
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve);ws.addEventListener('error',reject);});
    ws.addEventListener('message',(event)=>{
      const message=JSON.parse(event.data);
      if(message.id&&pending.has(message.id)){const entry=pending.get(message.id)!;pending.delete(message.id);clearTimeout(entry.timeout);message.error?entry.reject(new Error(JSON.stringify(message.error))):entry.resolve(message.result);}
    });
    const command=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{
      const id=++sequence,timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},10000);
      pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async(expression:string)=>{
      const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const click=async(text:string)=>{
      await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw new Error("No existe botón");b.click()})()');await delay(60);
    };
    const field=async(selector:string,value:string)=>{
      await evaluate('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');if(!el)throw new Error("No existe campo");Object.getOwnPropertyDescriptor(el.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))})()');await delay(60);
    };
    const text=()=>evaluate('document.body.innerText') as Promise<string>;
    const login=async(email:string,password:string)=>{
      await field('[aria-label="Email"]',email);await field('[aria-label="Contraseña"]',password);await click('Ingresar');
    };
    await command('Page.enable');
    await command('Page.navigate',{url:origin});
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Email"]\')'),'No apareció la pantalla de acceso.');
    // Sin sesión no se ve ningún dato.
    assert.ok(!(await text()).includes('Control de Gastos del Hogar'));
    await login('ana@familia.test','mala');
    await waitFor(async()=>(await text()).includes('Email o contraseña incorrectos.'),'No mostró el error de credenciales.');
    // Cuenta válida sin integrante: pantalla de acceso denegado, sin datos.
    await login('ghost@familia.test','clave-ok');
    await waitFor(async()=>(await text()).includes('Tu cuenta todavía no tiene acceso'),'No mostró el acceso denegado.');
    await click('Cerrar sesión');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Email"]\')'),'No volvió al acceso.');
    await login('ana@familia.test','clave-ok');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Mes del dashboard"]\')'),'No cargó el panel con sesión.');
    assert.ok(!(await text()).includes('Sin integrante especificado'));
    // Integrante: panel personal y solo su menú.
    assert.ok((await text()).includes('Mi resumen de gastos'));
    for(const label of ['Presupuestos','Gastos fijos','Tarjetas e integrantes'])assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==='+JSON.stringify(label)+')'),false,label);
    assert.equal(await evaluate('!!document.querySelector(\'[aria-label="Integrante del dashboard"]\')'),false);
    // La sesión sobrevive a una recarga.
    await command('Page.reload');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Mes del dashboard"]\')'),'La sesión no se restauró.');
    // Gasto desde la web: sin selector de integrante; el autor es quien inició sesión.
    await click('Cargar Gasto');
    assert.equal(await evaluate('!!document.querySelector(\'[aria-label="Informado por"]\')'),false);
    assert.ok((await text()).includes('Registrado por: Ana'));
    await field('[aria-label="Descripción"]','Compra web');await field('[aria-label="Monto"]','40000');
    await field('[aria-label="Fecha"]','2026-10-08');await field('[aria-label="Categoría"]',category);await field('[aria-label="Medio de pago"]','cash');
    await click('Guardar Gasto');
    await waitFor(()=>evaluate('!document.querySelector("[role=dialog]")'),'No se guardó el gasto.');
    const saved=(await db.pool.query("SELECT reported_by_member_id FROM appgastos.expenses WHERE description='Compra web'")).rows[0];
    assert.equal(saved.reported_by_member_id,member);
    await click('Historial de Gastos');
    await waitFor(async()=>(await text()).includes('Compra web'),'No apareció en el historial.');
    assert.ok((await text()).includes('Ana'));
    // Perfil y vinculación: el código se genera en la web y se completa desde el "bot".
    await click('Mi perfil');
    await waitFor(async()=>(await text()).includes('ana@familia.test'),'No mostró el perfil.');
    await click('Vincular WhatsApp');
    const code=await waitFor(async()=>/VINCULAR ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(await text())?.[1],'No mostró el código.');
    const result=await transaction(db.pool,tx=>attemptLink(tx,INITIAL_FAMILY_ID,'5491155550001',code));
    assert.equal(result.outcome,'linked');
    await waitFor(async()=>(await text()).includes('+5491155550001'),'La web no detectó la vinculación.');
    // Cierre de sesión: vuelve al acceso y la API deja de responder con ese token.
    await click('Cerrar sesión');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Email"]\')'),'No cerró la sesión.');
    // Administrador: ve todo, arma presupuestos y gastos fijos.
    await login('jefa@familia.test','clave-ok');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Mes del dashboard"]\')'),'No cargó el panel del administrador.');
    assert.ok((await text()).includes('Control de Gastos del Hogar'));
    assert.equal(await evaluate('!!document.querySelector(\'[aria-label="Integrante del dashboard"]\')'),true);
    await field('[aria-label="Mes del dashboard"]','2026-10');
    await waitFor(async()=>(await text()).includes('40.000'),'El administrador no ve el gasto de otro integrante.');
    await click('Presupuestos');
    await field('[aria-label="Mes del presupuesto"]','2026-10');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Presupuesto de Compras"]\')'),'No mostró las categorías del presupuesto.');
    await field('[aria-label="Presupuesto de Compras"]','100000');
    await evaluate('document.querySelector(\'[aria-label="Presupuesto de Compras"]\').parentElement.querySelector("button").click()');
    await waitFor(async()=>(await text()).includes('Presupuesto guardado.'),'No guardó el presupuesto.');
    assert.equal((await db.pool.query("SELECT amount::text a FROM appgastos.budgets WHERE month='2026-10-01'")).rows[0].a,'100000.00');
    await click('Panel Central');
    await field('[aria-label="Mes del dashboard"]','2026-10');
    await waitFor(async()=>(await text()).includes('Presupuesto del mes')&&(await text()).includes('100.000'),'El panel no muestra el presupuesto.');
    await click('Gastos fijos');
    await field('[aria-label="Nombre del gasto fijo"]','Colegio');await field('[aria-label="Categoría del gasto fijo"]',category);
    await field('[aria-label="Importe previsto"]','40000');await field('[aria-label="Fecha de inicio"]','2026-10-01');
    await click('Crear gasto fijo');
    await waitFor(async()=>(await text()).includes('Gasto fijo creado.'),'No creó el gasto fijo.');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.fixed_expenses')).rows[0].n,1);
    // Vencida (el día 10 de octubre de 2026 ya pasó): queda a la vista y se marca como pagada creando el gasto real.
    await waitFor(async()=>(await text()).includes('Vencidas sin pagar (1)'),'La obligación vencida no quedó a la vista.');
    await click('Marcar como pagada');
    await field('[aria-label="Medio de pago del pago"]','transfer');
    await click('Confirmar pago');
    await waitFor(async()=>(await text()).includes('Pago registrado.'),'No registró el pago.');
    const paid=(await db.pool.query("SELECT e.scope,e.payment_method,o.link_source FROM appgastos.fixed_expense_occurrences o JOIN appgastos.expenses e ON e.id=o.expense_id")).rows;
    assert.deepEqual(paid.map(r=>[r.scope,r.payment_method,r.link_source]),[['household','transfer','manual']]);
    await waitFor(async()=>!(await text()).includes('Vencidas sin pagar ('),'Siguió figurando como vencida.');
    await click('Cerrar sesión');
    await waitFor(()=>evaluate('!!document.querySelector(\'[aria-label="Email"]\')'),'No cerró la sesión del administrador.');
    await command('Browser.close');
  }finally{
    ws?.close();
    for(const entry of pending.values()){clearTimeout(entry.timeout);entry.reject(new Error('Prueba terminada'));}
    browser?.kill();server.kill();supabase.close();await db.stop();await delay(300);removeDirectory(profile);
  }
});
