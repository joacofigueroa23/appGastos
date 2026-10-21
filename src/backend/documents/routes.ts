import type {Express} from 'express';
import type {Pool} from 'pg';
import {transaction} from '../expenses/repository';
import {fixedService} from '../fixed/service';
import {ApiError} from '../shared/errors';
import {apiRoute} from '../shared/route';
import {requireAdmin} from '../accounts/policy';
import {object,uuid} from '../shared/validators';
import {buildFor,cancelDocument,canAccess,canOperate,changeKind,confirmDocument,createWebDocument,DocumentActionError,editDocument,loadContext,lockDocument,type DocRow,type Viewer} from './service';
import type {DocumentKind} from './types';
import type {Edit} from './draft';
import {geminiDocumentExtractor,type DocumentExtractor} from './extraction';
import {sheetToText,isSheetName,XLSX_MIME} from './sheet';
import {detectType,DocumentError,failureReply,validateMedia} from './validate';
import {documentLimits} from './limits';
import {createHash} from 'node:crypto';
// Pantalla "Comprobantes": cada integrante ve y opera SUS documentos; el administrador, además, revisa las facturas pendientes.
// Registrar antes de registerDatabaseApi.
const KINDS:DocumentKind[]=['purchase_receipt','pending_invoice','payment_receipt','card_statement'];
const dto=(d:DocRow,viewer:Viewer,authorName?:string|null)=>({
 id:d.id,shortCode:d.short_code,kind:d.kind,state:d.state,createdAt:d.created_at.toISOString(),expiresAt:d.expires_at.toISOString(),errorCode:d.error_code,
 // El autor solo lo ve un administrador (para las facturas que llegan de otros).
 author:viewer.role==='admin'?authorName??null:null,mine:viewer.memberId===d.member_id,
 draft:d.state==='needs_review'?d.draft:null,result:d.state==='confirmed'?d.result:null,
});
const toApiError=(error:unknown)=>error instanceof DocumentActionError?new ApiError(409,error.message):error;
export function registerDocuments(app:Express,pool:Pool|null,extractor?:DocumentExtractor){
 const route=apiRoute(pool,false);
 const viewerOf=(actor:{role:'admin'|'member';memberId:string|null}):Viewer=>({memberId:actor.memberId,role:actor.role});
 app.get('/api/documents',route(async(_req,res,db,family,actor)=>{
  const v=viewerOf(actor);
  const rows=(await db.query(`SELECT d.*,m.name AS author_name FROM appgastos.documents d JOIN appgastos.family_members m ON m.id=d.member_id
   WHERE d.family_id=$1 AND (d.member_id=$2 OR ($3 AND (d.kind='pending_invoice' OR $2::uuid IS NULL))) AND d.created_at>now()-interval '60 days' ORDER BY d.created_at DESC LIMIT 60`,[family,v.memberId,v.role==='admin'])).rows;
  res.json({documents:rows.map(r=>dto(r,v,r.author_name))});
 }));
 // Subida desde la web: foto, PDF, CSV o Excel. Se lee en el momento (sin guardar el archivo) y queda un borrador para revisar; nada se registra.
 // Una planilla se interpreta como lista de movimientos que se discriminan por categoría.
 app.post('/api/documents/upload',route(async(req,res,db,family,actor)=>{
  const v=viewerOf(actor),body=object(req.body);
  if(!v.memberId)throw new ApiError(403,'Para subir comprobantes iniciá sesión con tu cuenta de integrante.');
  const name=typeof body.filename==='string'?body.filename.slice(0,200):'',b64=typeof body.contentBase64==='string'?body.contentBase64:'';
  if(!b64||!/^[A-Za-z0-9+/=\s]+$/.test(b64))throw new ApiError(400,'Archivo inválido.');
  const bytes=Buffer.from(b64,'base64'),limits=documentLimits();
  const recent=(await db.query("SELECT count(*)::int n FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND created_at>now()-interval '1 hour'",[family,v.memberId])).rows[0].n;
  if(recent>=limits.perHour)throw new ApiError(429,'Llegaste al límite de comprobantes por hora. Probá más tarde.');
  const sha=createHash('sha256').update(bytes).digest('hex');
  const dup=(await db.query("SELECT short_code,state FROM appgastos.documents WHERE family_id=$1 AND member_id=$2 AND media_sha256=$3 AND state IN ('received','processing','needs_review','confirmed')",[family,v.memberId,sha])).rows[0];
  if(dup)throw new ApiError(409,'Ese archivo ya lo subiste (código '+dup.short_code+', '+(dup.state==='confirmed'?'ya registrado':'todavía abierto')+').');
  try{
   const sheet=isSheetName(name);
   const input=sheet?(()=>{const s=sheetToText(bytes,name);return {bytes:Buffer.from(s.text,'utf8'),mime:'text/csv' as const,mimeStored:name.toLowerCase().endsWith('.xlsx')?XLSX_MIME:'text/csv'};})()
    :(()=>{const m=validateMedia(bytes,detectType(bytes)??'');return {bytes,mime:m.mime,mimeStored:m.mime};})();
   const ctx=await loadContext(db,family);
   const owner=(await db.query('SELECT role FROM appgastos.family_members WHERE id=$1',[v.memberId])).rows[0];
   const {extraction,usage}=await (extractor??(extractor=geminiDocumentExtractor()))({bytes:input.bytes,mime:input.mime,categories:ctx.categories.filter(c=>c.active).map(c=>c.name),today:ctx.today,familyCurrency:ctx.familyCurrency});
   const built=await buildFor(db,{family_id:family,member_id:v.memberId,short_code:'',household_hint:false},extraction,ctx,{memberId:v.memberId,role:owner.role});
   const row=await createWebDocument(db,{family,member:v.memberId,mime:input.mimeStored,sha,kind:built.kind,extraction,draft:built.draft,usage,ttl:limits.ttlHours});
   res.status(201).json({document:dto(row,v)});
  }catch(error){
   if(error instanceof DocumentError)throw new ApiError(error.transient?503:400,failureReply(error.code));
   throw error;
  }
 }));
 // Métricas técnicas (sin contenido de documentos): estados, reintentos, duración, tokens y costo estimado si hay precios configurados.
 app.get('/api/documents/metrics',route(async(req,res,db,family,actor)=>{
  requireAdmin(actor);
  const days=Math.min(Math.max(Number(req.query.days)||30,1),365);
  const states=(await db.query("SELECT state,count(*)::int AS n FROM appgastos.documents WHERE family_id=$1 AND created_at>now()-($2||' days')::interval GROUP BY state",[family,String(days)])).rows;
  const errors=(await db.query("SELECT error_code AS code,count(*)::int AS n FROM appgastos.documents WHERE family_id=$1 AND created_at>now()-($2||' days')::interval AND state='failed' GROUP BY 1 ORDER BY 2 DESC",[family,String(days)])).rows;
  const totals=(await db.query("SELECT COALESCE(sum(attempts-1),0)::int AS retries,round(avg((usage->>'ms')::numeric))::int AS \"avgMs\",sum((usage->>'totalTokens')::bigint)::text AS tokens,sum((usage->>'estimatedCostUsd')::numeric)::text AS cost FROM appgastos.documents WHERE family_id=$1 AND created_at>now()-($2||' days')::interval",[family,String(days)])).rows[0];
  res.json({days,byState:Object.fromEntries(states.map(r=>[r.state,r.n])),failedByCode:errors,retries:totals.retries,avgMs:totals.avgMs,totalTokens:totals.tokens,estimatedCostUsd:totals.cost});
 }));
 app.get('/api/documents/:id',route(async(req,res,db,family,actor)=>{
  const v=viewerOf(actor);
  const d:(DocRow&{author_name?:string})|undefined=(await db.query('SELECT d.*,m.name AS author_name FROM appgastos.documents d JOIN appgastos.family_members m ON m.id=d.member_id WHERE d.family_id=$1 AND d.id=$2',[family,uuid(req.params.id)])).rows[0];
  if(!d||!canAccess(v,d))throw new ApiError(404,'Comprobante inexistente.');
  // Para asociar una factura el administrador necesita las obligaciones sin pagar del mes de vencimiento y del mes actual.
  let occurrences:unknown[]=[];
  if(v.role==='admin'&&d.state==='needs_review'&&d.draft?.kind==='pending_invoice'){
   const months=[...new Set([(d.draft.dueDate||new Date().toISOString().slice(0,10)).slice(0,7),new Date().toISOString().slice(0,7)])];
   occurrences=(await Promise.all(months.map(m=>fixedService(db,family).occurrences(m)))).flat().filter(o=>o.status!=='paid');
  }
  res.json({document:{...dto(d,v,d.author_name),occurrences}});
 }));
 // Correcciones del borrador: no crean movimientos ni vuelven a llamar al modelo.
 app.patch('/api/documents/:id',route(async(req,res,db,family,actor)=>{
  const v=viewerOf(actor),body=object(req.body);
  const out=await transaction(db,async tx=>{
   const d=await lockDocument(tx,family,uuid(req.params.id));
   if(!d||!canAccess(v,d)||!canOperate(v,d))throw new ApiError(404,'Comprobante inexistente.');
   try{
    if(body.kind!==undefined){
     if(!KINDS.includes(body.kind as DocumentKind))throw new ApiError(400,'Tipo de comprobante inválido.');
     await changeKind(tx,d,body.kind as DocumentKind,actor.role);
    }
    if(Array.isArray(body.edits)&&body.edits.length){
     if(body.edits.length>200||body.edits.some(e=>!e||typeof e!=='object'||typeof (e as {type?:unknown}).type!=='string'))throw new ApiError(400,'Correcciones inválidas.');
     const fresh=await lockDocument(tx,family,d.id);
     await editDocument(tx,fresh!,body.edits as Edit[],actor.role);
    }
   }catch(error){throw toApiError(error);}
   return (await lockDocument(tx,family,d.id))!;
  });
  res.json({document:dto(out,v)});
 }));
 app.post('/api/documents/:id/confirm',route(async(req,res,db,family,actor)=>{
  const v=viewerOf(actor),input=object(req.body??{});
  const result=await transaction(db,async tx=>{
   const d=await lockDocument(tx,family,uuid(req.params.id));
   if(!d||!canAccess(v,d))throw new ApiError(404,'Comprobante inexistente.');
   try{
    const message=await confirmDocument(db,tx,d,v,{occurrenceId:input.occurrenceId===undefined?undefined:uuid(input.occurrenceId,'occurrenceId'),newFixedCategoryId:input.newFixedCategoryId===undefined?undefined:uuid(input.newFixedCategoryId,'newFixedCategoryId')});
    return {message,document:(await lockDocument(tx,family,d.id))!};
   }catch(error){throw toApiError(error);}
  });
  res.json({message:result.message,document:dto(result.document,v)});
 }));
 app.post('/api/documents/:id/cancel',route(async(req,res,db,family,actor)=>{
  const v=viewerOf(actor);
  const out=await transaction(db,async tx=>{
   const d=await lockDocument(tx,family,uuid(req.params.id));
   if(!d||!canAccess(v,d))throw new ApiError(404,'Comprobante inexistente.');
   try{const message=await cancelDocument(tx,d);return {message,document:(await lockDocument(tx,family,d.id))!};}
   catch(error){throw toApiError(error);}
  });
  res.json({message:out.message,document:dto(out.document,v)});
 }));
}
