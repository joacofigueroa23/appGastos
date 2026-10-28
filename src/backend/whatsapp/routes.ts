
import express,{type Express} from 'express';
import type {Pool} from 'pg';
import {resolveFamilyId} from '../expenses/service';
import {normalizePhone,validSignature} from './security';
import {enqueue,type IncomingMessage,type MessageMedia} from './repository';
import {geminiInterpreter,type Interpreter} from './interpretation';
import type {AdminInterpreter} from './adminIntent';
import {metaSender,metaTokenStatus,tappedButtonText,type ReplySender} from './transport';
import {whatsappProcessor} from './processor';
import {metaMediaFetcher} from '../documents/media';
import {geminiDocumentExtractor} from '../documents/extraction';
import type {DocumentDeps} from '../documents/service';
import {actorOf} from '../accounts/policy';
export interface WhatsAppOptions {adminInterpret?:AdminInterpreter;secret?:string;verifyToken?:string;phoneNumberId?:string;familyId?:string;interpret?:Interpreter;send?:ReplySender;startWorker?:boolean;documents?:DocumentDeps}
export function registerWhatsApp(app:Express,pool:Pool|null,options:WhatsAppOptions={}){
 const processor=pool?whatsappProcessor(pool,options.interpret||geminiInterpreter(),options.send||metaSender(),options.documents||{fetchMedia:metaMediaFetcher(),extract:geminiDocumentExtractor()},options.adminInterpret):null;
 const configured=!!((options.secret??process.env.WHATSAPP_APP_SECRET)&&(options.phoneNumberId??process.env.WHATSAPP_PHONE_NUMBER_ID));
 const stop=options.startWorker===false||!configured?()=>{}:processor?.start()||(()=>{});
 // Aviso temprano: un token temporal de Meta vence a las 24 h y las respuestas dejan de salir.
 if(options.startWorker!==false&&configured&&!options.send)void metaTokenStatus().then(status=>{
  if(status==='expired')console.warn('whatsapp: meta_token_expired — generar un token permanente de System User (docs/whatsapp.md)');
  else if(status==='expires_soon')console.warn('whatsapp: meta_token_expires_soon — reemplazarlo por un token permanente de System User');
  else if(status==='ok')console.warn('whatsapp: meta_token_temporary — vence; usar un token permanente de System User');
 });
 app.get('/api/whatsapp/webhook',(req,res)=>{
  const token=options.verifyToken??process.env.WHATSAPP_VERIFY_TOKEN;
  if(token&&req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===token&&typeof req.query['hub.challenge']==='string')return void res.status(200).send(req.query['hub.challenge']);
  res.status(403).json({error:'Verificación rechazada.'});
 });
 app.post('/api/whatsapp/webhook',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
  const secret=options.secret??process.env.WHATSAPP_APP_SECRET;
  if(!secret)return void res.status(503).json({error:'Webhook no configurado.'});
  if(!Buffer.isBuffer(req.body)||!validSignature(req.body,req.get('X-Hub-Signature-256'),secret))return void res.status(403).json({error:'Firma inválida.'});
  if(!pool)return void res.status(503).json({error:'Persistencia no disponible.'});
  const phoneId=options.phoneNumberId??process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!phoneId||(!options.send&&!process.env.WHATSAPP_ACCESS_TOKEN))return void res.status(503).json({error:'Envío WhatsApp no configurado.'});
  let body:any;
  try{body=JSON.parse(req.body.toString('utf8'));}catch{return void res.status(400).json({error:'JSON inválido.'});}
  if(body?.object!=='whatsapp_business_account'||!Array.isArray(body.entry))return void res.status(400).json({error:'Evento inválido.'});
  const messages:IncomingMessage[]=[];
  try{
   for(const entry of body.entry){
    if(!Array.isArray(entry.changes))throw new Error();
    for(const change of entry.changes){
     if(change.field!=='messages')continue;
     const value=change.value;
     if(value?.metadata?.phone_number_id!==phoneId)continue;
     if(value.messages===undefined)continue;
     if(!Array.isArray(value.messages))throw new Error();
     for(const m of value.messages){
      const sender=normalizePhone(m.from);
      if(!sender||typeof m.id!=='string'||!m.id||m.id.length>256||typeof m.type!=='string'||m.type.length>40)throw new Error();
      if(m.type==='text'&&(typeof m.text?.body!=='string'||!m.text.body.trim()||m.text.body.length>4096))throw new Error();
      // timestamp de Meta: segundos Unix como string. Inválido o ausente → se ordena por recepción.
      const metaTimestamp=typeof m.timestamp==='string'&&/^\d{1,12}$/.test(m.timestamp)?new Date(Number(m.timestamp)*1000):null;
      // Imagen o documento: solo se guardan los datos que declara Meta. El archivo se pide después por su id (nunca por una URL del mensaje).
      let media:MessageMedia|null=null;
      if(m.type==='image'||m.type==='document'){
       const item=m[m.type],str=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max?v:null;
       if(!item||typeof item.id!=='string'||!item.id||item.id.length>256)throw new Error();
       media={id:item.id,mime:str(item.mime_type,100)||'',sha256:str(item.sha256,128),filename:str(item.filename,255),caption:str(item.caption,1024)};
      }
      // Un toque de botón entra como el texto equivalente: sigue el mismo camino (y las mismas validaciones) que si lo hubiera escrito.
      const tapped=m.type==='interactive'?tappedButtonText(m.interactive):null;
      messages.push({id:m.id,sender,text:tapped??(m.type==='text'?m.text.body:null),type:tapped?'text':m.type,receivedAt:new Date(),metaTimestamp,media});
      if(messages.length>100)throw new Error();
     }
    }
   }
  }catch{return void res.status(400).json({error:'Mensaje inválido.'});}
  try{
   if(messages.length)await enqueue(pool,options.familyId||await resolveFamilyId(pool),messages);
   res.status(200).send('EVENT_RECEIVED');
   if(options.startWorker!==false)setImmediate(()=>void processor?.drain());
  }catch{console.warn('whatsapp: receipt_failed');res.status(503).json({error:'No se pudo persistir la recepción; reintenta.'});}
 });
 app.use('/api/whatsapp/webhook',((error, _req, res, _next)=>{
  res.status(error?.status===413?413:400).json({error:'Cuerpo del webhook inválido o demasiado grande.'});
 }) as express.ErrorRequestHandler);
 // La configuración (aun enmascarada) y los registros son del administrador.
 const adminOnly:express.RequestHandler=(_req,res,next)=>actorOf(res).role==='admin'?next():void res.status(403).json({error:'Esta operación es solo para administradores.'});
 app.get('/api/whatsapp/config',adminOnly,(_req,res)=>res.json({
  verifyToken:'',phoneNumberId:process.env.WHATSAPP_PHONE_NUMBER_ID?'••••'+process.env.WHATSAPP_PHONE_NUMBER_ID.slice(-4):'',
  hasAccessToken:!!process.env.WHATSAPP_ACCESS_TOKEN,hasAppSecret:!!process.env.WHATSAPP_APP_SECRET,
  hasVerifyToken:!!process.env.WHATSAPP_VERIFY_TOKEN,
  webhookUrl:(process.env.APP_URL||'')+'/api/whatsapp/webhook',
 }));
 app.post('/api/whatsapp/config',(_req,res)=>res.status(403).json({error:'Configura WhatsApp exclusivamente mediante variables del servidor.'}));
 app.get('/api/whatsapp/logs',adminOnly,(_req,res)=>res.json({logs:[]}));
 app.use('/api/whatsapp',(_req,res)=>res.status(410).json({error:'Simulador anterior preservado en modo demo; no registra gastos reales.'}));
 return {processor,stop};
}
