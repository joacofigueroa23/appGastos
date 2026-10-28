import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionApp,INITIAL_FAMILY_ID} from './helpers/sessionApp';
import {enqueue} from '../src/backend/whatsapp/repository';
import type {DocumentDeps} from '../src/backend/documents/service';
import {DocumentError} from '../src/backend/documents/validate';
import {parseRecovery} from '../src/backend/documents/focus';
import {InterpretationError} from '../src/backend/whatsapp/candidate';
import type {TurnProposal} from '../src/backend/documents/turn';
import type {Extraction} from '../src/backend/documents/types';

const BLANK:Extraction={documentType:'purchase_receipt',merchant:null,documentDate:null,dueDate:null,currency:'ARS',totalAmount:null,taxesIncluded:null,items:[],rounding:null,discounts:[],taxes:[],surcharges:[],paymentStatus:'unknown',paymentMethod:null,paymentReference:null,isCardPayment:null,isOwnTransfer:null,statementPeriod:null,closingDate:null,statementTotals:[],lines:[],invoiceReference:null,concept:null,category:null,configList:{kind:null,items:[]},warnings:[],missingFields:[]};
// Sin categoría ni medio de pago: el bot tiene que preguntar. «cash» trae el pago resuelto y falta solo la categoría.
const SCENARIOS:Record<string,Extraction>={
 nocat:{...BLANK,merchant:'Tienda Demo',documentDate:'2026-10-13',totalAmount:'9000.00',paymentMethod:'cash',items:[{description:'Bananas',amount:'9000.00',category:null}]},
 transfer:{...BLANK,documentType:'payment_receipt',merchant:'Brenda',documentDate:'2026-10-27',totalAmount:'11600.00',paymentStatus:'paid',items:[]},
};
const jpeg=(scenario:string)=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('SCENARIO:'+scenario),Buffer.alloc(8,1)]);
const BETO='5491100000002';

test('Contexto: respuestas con varios datos, recuperación y cancelación',async(t)=>{
 const files=new Map<string,Buffer>();
 const deps:DocumentDeps={
  fetchMedia:async id=>{const b=files.get(id);if(!b)throw new DocumentError('media_gone');return {bytes:b,mime:'image/jpeg'};},
  extract:async input=>({extraction:SCENARIOS[/SCENARIO:([a-z0-9_-]+)/.exec(input.bytes.toString('latin1'))![1]],usage:{model:'m',promptTokens:1,outputTokens:1,totalTokens:2,estimatedCostUsd:null,ms:1}}),
 };
 process.env.DOCUMENT_AUTO_REGISTER='false';t.after(()=>{delete process.env.DOCUMENT_AUTO_REGISTER;});
 const turn={calls:0,next:(null as TurnProposal|Error|null)};
 const app=await sessionApp({documents:deps,turn:async()=>{turn.calls++;if(turn.next instanceof Error)throw turn.next;return turn.next??{relatedToReceipt:false,category:null,paymentMethod:null,scope:null,dateText:null,totalText:null,confirm:false,cancel:false};}});
 t.after(()=>app.stop());
 const {q,processor,replies}=app;
 const beto=await app.account('beto',{phone:BETO});
 const sup=await app.category('Supermercado');await app.category('Comida');
 let n=0;
 const settle=async()=>{for(let i=0;i<40;i++){const a=await processor.processNext(),b=await processor.processDocument(),c=await processor.replyNext();if(!a&&!b&&!c)break;}};
 const photo=async(scenario:string)=>{const id=String(2000+(++n));files.set(id,jpeg(scenario));await enqueue(app.db.pool,INITIAL_FAMILY_ID,[{id:'wamid.p'+n,sender:BETO,text:null,type:'image',receivedAt:new Date(),media:{id,mime:'image/jpeg',sha256:'sha-'+n,filename:null,caption:null}}]);await settle();};
 const say=async(text:string)=>{n++;await enqueue(app.db.pool,INITIAL_FAMILY_ID,[{id:'wamid.t'+n,sender:BETO,text,type:'text',receivedAt:new Date()}]);await settle();return replies.at(-1)!.text;};
 const expenses=async()=>(await q('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n as number;
 const active=async()=>(await q("SELECT count(*)::int n FROM appgastos.whatsapp_conversations WHERE status='active'")).rows[0].n as number;
 const doc=async()=>(await q('SELECT * FROM appgastos.documents ORDER BY created_at DESC LIMIT 1')).rows[0];
 const clean=async()=>{await q('DELETE FROM appgastos.expense_items');await q('UPDATE appgastos.expenses SET document_id=NULL');await q('DELETE FROM appgastos.documents');await q('DELETE FROM appgastos.expenses');await q('UPDATE appgastos.whatsapp_messages SET conversation_id=NULL');await q('DELETE FROM appgastos.whatsapp_conversations');await q('DELETE FROM appgastos.admin_actions');replies.length=0;};

 await t.test('reconoce los comandos de recuperación',()=>{
  assert.equal(parseRecovery('¿Qué tengo pendiente?'),'pending');assert.equal(parseRecovery('cancelá todo'),'cancelAll');assert.equal(parseRecovery('Empezar de nuevo'),'cancelAll');
  assert.equal(parseRecovery('volvamos al ticket'),'backToTicket');assert.equal(parseRecovery('ese gasto no'),'dropExpense');assert.equal(parseRecovery('me equivoqué'),'dropExpense');
  assert.equal(parseRecovery('gasté 500 en kiosco'),null);
 });

 await t.test('categoría + confirmar en un solo mensaje registra el ticket y no abre un gasto nuevo (Caso A)',async()=>{
  for(const phrase of ['Supermercado confirmar','Supermercado, confirmá','ponelo en supermercado y guardalo','sí, en supermercado','Supermercado. Confirmar','confirmar supermercado']){
   await clean();await photo('nocat');
   assert.match(replies.at(-1)!.text,/Categoría|categoría/);
   const reply=await say(phrase);
   assert.doesNotMatch(reply,/Cuánto gastaste/,phrase);assert.equal(await active(),0,phrase);assert.equal(await expenses(),1,phrase);
   assert.equal((await doc()).state,'confirmed',phrase);
   const cat=(await q('SELECT category_id FROM appgastos.expenses')).rows[0].category_id;assert.equal(cat,sup,phrase);
  }
 });

 await t.test('datos sueltos sin confirmar actualizan el borrador y siguen esperando',async()=>{
  for(const phrase of ['fue en supermercado','Supermercado ayer','Supermercado y efectivo','efectivo y supermercado']){
   await clean();await photo('nocat');
   const reply=await say(phrase);
   assert.doesNotMatch(reply,/Cuánto gastaste/,phrase);assert.equal(await active(),0,phrase);assert.equal(await expenses(),0,phrase);
   assert.equal((await doc()).state,'needs_review',phrase);
  }
 });

 await t.test('todo o nada: una parte que no se entiende no aplica ni confirma nada',async()=>{
  await clean();await photo('nocat');
  const reply=await say('Supermercado y blablá confirmar');
  assert.equal(await expenses(),0);assert.equal((await doc()).state,'needs_review');assert.equal(await active(),0);
  assert.doesNotMatch(reply,/Cuánto gastaste/);
  assert.equal((await doc()).draft.items.every((i:{categoryId:string|null})=>!i.categoryId),true);
 });

 await t.test('un mensaje corto sin importe no abre un gasto mientras hay un comprobante esperando',async()=>{
  await clean();await photo('nocat');
  const reply=await say('pan');
  assert.match(reply,/Tengo abierto/);assert.equal(await active(),0);assert.equal((await doc()).state,'needs_review');
 });

 await t.test('corrección de total: «No, fueron 11600, no 35689»',async()=>{
  await clean();await photo('transfer');
  const reply=await say('No, fueron 12000, no 35689');
  assert.match(reply,/12\.000/);assert.equal((await doc()).draft.total,'12000.00');assert.equal(await expenses(),0);
 });

 await t.test('«¿qué tengo pendiente?» lista y «cancelá todo» descarta sin tocar lo registrado',async()=>{
  await clean();
  assert.match(await say('¿Qué tengo pendiente?'),/nada pendiente/);
  await photo('nocat');await say('Supermercado confirmar');assert.equal(await expenses(),1);
  await photo('transfer');
  // Un gasto a medias que atrapa el «confirmar» (el estado del Caso A).
  await q("INSERT INTO appgastos.whatsapp_conversations(family_id,member_id,draft,expected_field,expires_at) VALUES($1,$2,'{}','amount',now()+interval '10 minutes')",[INITIAL_FAMILY_ID,beto.id]);
  const list=await say('¿qué tengo pendiente?');
  assert.match(list,/gasto que estabas cargando/);assert.match(list,/Brenda/);
  const all=await say('cancelá todo');
  assert.match(all,/cancelé todo/);assert.equal(await active(),0);assert.equal((await doc()).state,'cancelled');assert.equal(await expenses(),1,'lo ya registrado no se toca');
  assert.match(await say('qué tengo pendiente'),/nada pendiente/);
 });

 await t.test('«ese gasto no» descarta el gasto en curso y «volvamos al ticket» retoma el comprobante',async()=>{
  await clean();await photo('transfer');
  await q("INSERT INTO appgastos.whatsapp_conversations(family_id,member_id,draft,expected_field,expires_at) VALUES($1,$2,'{}','amount',now()+interval '10 minutes')",[INITIAL_FAMILY_ID,beto.id]);
  assert.match(await say('volvamos al ticket'),/volvemos a .*Brenda/);assert.equal(await active(),0);
  await q("INSERT INTO appgastos.whatsapp_conversations(family_id,member_id,draft,expected_field,expires_at) VALUES($1,$2,'{}','amount',now()+interval '10 minutes')",[INITIAL_FAMILY_ID,beto.id]);
  assert.match(await say('ese gasto no'),/descarté ese gasto.*Seguimos con.*Brenda/s);assert.equal(await active(),0);assert.equal((await doc()).state,'needs_review');
 });

 const proposal=(o:Partial<TurnProposal>):TurnProposal=>({relatedToReceipt:true,category:null,paymentMethod:null,scope:null,dateText:null,totalText:null,confirm:false,cancel:false,...o});

 await t.test('respaldo con Gemini: solo si las reglas no entienden, y validado por el backend (Etapa C)',async()=>{
  await clean();await photo('nocat');turn.calls=0;
  await say('Supermercado confirmar');assert.equal(turn.calls,0,'lo que las reglas entienden no llama a Gemini');
  await clean();await photo('nocat');
  turn.next=proposal({category:'Supermercado',confirm:true});
  await say('dejalo en súper y cargalo');
  assert.equal(turn.calls,1);assert.equal(await expenses(),1);assert.equal(await active(),0);
  const cat=(await q('SELECT category_id FROM appgastos.expenses')).rows[0].category_id;assert.equal(cat,sup);
  // El modelo no puede confirmar solo: sin palabras de confirmación en el mensaje, queda el dato y nada se registra.
  await clean();await photo('nocat');
  turn.next=proposal({category:'Supermercado',confirm:true});
  await say('ponele súper nomás');
  assert.equal(await expenses(),0);assert.equal((await doc()).state,'needs_review');assert.equal((await doc()).draft.items[0].categoryId,sup);
  // Categoría inventada: no se aplica nada.
  await clean();await photo('nocat');
  turn.next=proposal({category:'Inventada',paymentMethod:'cash',confirm:true});
  await say('mandalo a inventada y cargalo');
  assert.equal(await expenses(),0);assert.equal((await doc()).draft.items[0].categoryId??null,null);
  // Mensaje que no es del comprobante, o Gemini caído: no se toca el comprobante ni se rompe nada.
  await clean();await photo('nocat');
  turn.next=proposal({relatedToReceipt:false,category:'Supermercado'});await say('qué lindo día hoy');
  turn.next=new InterpretationError('transient','http_503');await say('dejalo en súper y cargalo');
  assert.equal(await expenses(),0);assert.equal((await doc()).state,'needs_review');assert.equal(await active()<=1,true);
  // Descartar pedido por Gemini, con palabra de descarte en el mensaje.
  await clean();await photo('nocat');
  turn.next=proposal({cancel:true});await say('tirá esto, descartalo');
  assert.equal((await doc()).state,'cancelled');
 });
});
