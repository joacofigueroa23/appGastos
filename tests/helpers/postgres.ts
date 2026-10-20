
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createDatabasePool} from '../../src/backend/db/pool';
export async function freePort():Promise<number>{
 const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
 const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;
}
// Cada base temporal pesa ~40 MB: sin borrarla, un disco se llena tras unos cientos de corridas ("No space left on device").
export const removeDirectory=(path:string)=>{try{rmSync(path,{recursive:true,force:true,maxRetries:10,retryDelay:300});}catch{/* un archivo bloqueado no debe fallar el test */}};
export async function isolatedDatabase(){
 const bin=process.env.TEST_PG_BIN||'C:/Program Files/PostgreSQL/17/bin';
 if(!existsSync(join(bin,'initdb.exe')))throw new Error('Configura TEST_PG_BIN. Los tests no usan DATABASE_URL.');
 const directory=mkdtempSync(join(tmpdir(),'appgastos-pg-test-'));
 const init=spawnSync(join(bin,'initdb.exe'),['-D',directory,'-U','testuser','--auth=trust','--encoding=UTF8','--locale=C'],{windowsHide:true,encoding:'utf8'});
 if(init.status!==0)throw new Error('initdb temporal: '+init.stderr);
 const port=await freePort(), url='postgresql://testuser@127.0.0.1:'+port+'/postgres';
 const child=spawn(join(bin,'postgres.exe'),['-D',directory,'-h','127.0.0.1','-p',String(port)],{windowsHide:true,stdio:'ignore'});
 const pool=createDatabasePool(url);
 try{
  const end=Date.now()+20000;let ready=false;
  while(Date.now()<end){try{await pool.query('SELECT 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!ready)throw new Error('PostgreSQL temporal no inici?.');
 }catch(e){await pool.end();child.kill();removeDirectory(directory);throw e;}
 return {pool,url,async stop(){await pool.end();spawnSync(join(bin,'pg_ctl.exe'),['stop','-D',directory,'-m','fast','-w'],{windowsHide:true,stdio:'ignore'});const exited=new Promise<void>(r=>{child.once('exit',()=>r());setTimeout(r,5000);});child.kill();await exited;removeDirectory(directory);}};
}
