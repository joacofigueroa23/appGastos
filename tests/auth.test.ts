import test from 'node:test';
import assert from 'node:assert/strict';
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
