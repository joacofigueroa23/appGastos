import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import express from 'express';
import {authFromEnv,basicAuth} from '../src/backend/auth';
import {registerWhatsApp} from '../src/backend/whatsapp/routes';
test('Basic Auth protege /api y deja pasar el webhook',async()=>{
 const app=express();app.use(basicAuth('familia','clave'));
 registerWhatsApp(app,null,{secret:'s',phoneNumberId:'1',startWorker:false});
 app.get('/api/ping',(_req,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const url='http://127.0.0.1:'+(server.address() as any).port;
 const basic=(u:string,p:string)=>({Authorization:'Basic '+Buffer.from(u+':'+p).toString('base64')});
 try{
  const none=await fetch(url+'/api/ping');
  assert.equal(none.status,401);assert.equal(none.headers.get('www-authenticate'),'Basic realm="appGastos"');
  assert.equal((await fetch(url+'/api/ping',{headers:basic('familia','mala')})).status,401);
  assert.equal((await fetch(url+'/api/ping',{headers:basic('familia','clave')})).status,200);
  // Sin Authorization llega al webhook, que rechaza por firma (403), no por 401.
  assert.equal((await fetch(url+'/api/whatsapp/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{server.close();}
});
test('en producción sin credenciales no arranca',()=>{
 assert.throws(()=>authFromEnv({NODE_ENV:'production'}),/APP_AUTH_USER/);
 assert.equal(authFromEnv({}),null);
});
test('demo + production: el simulador responde 410',async()=>{
 const port=39000+Math.floor(Math.random()*500);
 const child=spawn(process.execPath,['--import','tsx','server.ts'],{windowsHide:true,env:{...process.env,PORT:String(port),NODE_ENV:'production',VITE_ENABLE_DEMO:'true',DATABASE_URL:'',APP_AUTH_USER:'u',APP_AUTH_PASSWORD:'p',FRONTEND_DIST_DIR:'dist'}});
 try{
  const headers={Authorization:'Basic '+Buffer.from('u:p').toString('base64'),'Content-Type':'application/json'};
  let res:Response|undefined;
  for(let i=0;i<60&&!res;i++){try{res=await fetch(`http://127.0.0.1:${port}/api/whatsapp/simulate`,{method:'POST',headers,body:'{}'});}catch{await new Promise(r=>setTimeout(r,250));}}
  assert.equal(res?.status,410);
 }finally{child.kill();}
});
