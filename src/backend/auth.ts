import {createHash,timingSafeEqual} from 'node:crypto';
import type {RequestHandler} from 'express';
import {supabaseFromEnv} from './accounts/session';
const digest=(value:string)=>createHash('sha256').update(value).digest();
// El webhook de Meta queda fuera: ya valida X-Hub-Signature-256.
export function basicAuth(user:string,password:string):RequestHandler{
 const expected=digest(user+':'+password);
 return (req,res,next)=>{
  if(req.path==='/api/whatsapp/webhook')return next();
  const header=req.get('Authorization')||'';
  const given=header.startsWith('Basic ')?Buffer.from(header.slice(6),'base64').toString('utf8'):'';
  if(timingSafeEqual(digest(given),expected))return next();
  res.set('WWW-Authenticate','Basic realm="appGastos"').status(401).send('Autenticación requerida.');
 };
}
// Sin credenciales: en producción el servidor no arranca; en desarrollo queda abierto.
export function authFromEnv(env=process.env):RequestHandler|null{
 // Con Supabase Auth configurado la identidad es individual (sessionAuth); Basic Auth no se aplica a la vez.
 if(supabaseFromEnv(env))return null;
 const {APP_AUTH_USER:user,APP_AUTH_PASSWORD:password}=env;
 if(user&&password)return basicAuth(user,password);
 if(env.NODE_ENV==='production')throw new Error('Faltan APP_AUTH_USER y APP_AUTH_PASSWORD (o SUPABASE_URL y SUPABASE_ANON_KEY): el servidor no arranca en producción sin autenticación.');
 return null;
}
