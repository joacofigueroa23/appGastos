
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import express from 'express';
import {isolatedDatabase} from './helpers/postgres';
import {migrate} from '../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../scripts/seed';
import {InterpretationError,parseInterpretation,referenceDate,resolveDate,validateExpenseCandidate,normalizeTextAmount,type Interpretation,type InterpretationContext} from '../src/backend/whatsapp/candidate';
import {normalizePhone,validSignature} from '../src/backend/whatsapp/security';
import {geminiInterpreter} from '../src/backend/whatsapp/interpretation';
import {enqueue,claim} from '../src/backend/whatsapp/repository';
import {whatsappProcessor} from '../src/backend/whatsapp/processor';
import {registerWhatsApp} from '../src/backend/whatsapp/routes';
import {registerDatabaseApi} from '../src/backend/expenses/routes';
import {recipientNumber,metaTokenStatus} from '../src/backend/whatsapp/transport';

const member={id:randomUUID(),name:'Ana',active:true};
const category={id:randomUUID(),name:'Supermercado',active:true};
const card={id:randomUUID(),name:'Visa',active:true,cardType:null};
const base:Interpretation={amount:'35000',amountText:'35000',dateText:null,currency:null,currencyText:null,merchant:'Carrefour',description:'Compra en Carrefour',category:'Supermercado',paymentMethod:'credit_card',paymentMethodText:'crédito',card:'Visa'};
const context:InterpretationContext={text:'Gasté 35000 en Carrefour con Visa crédito',referenceDate:'2026-10-11',defaultCurrency:'ARS',categories:[category],cards:[card],member};

test('Candidato: validación determinista, fechas, monedas y ausencia de fallbacks',async(t)=>{
 await t.test('mensaje completo, integrante y tarjeta válidos',()=>{
  const r=validateExpenseCandidate(base,context);assert.equal(r.valid,true);
  assert.equal(r.expense!.amount,'35000.00');assert.equal(r.expense!.date,'2026-10-11');assert.equal(r.expense!.currency,'ARS');
  assert.equal(r.expense!.reportedByMemberId,member.id);assert.equal(r.expense!.cardId,card.id);
 });
 await t.test('monto faltante; la descripción se deriva y nunca falta',()=>{
  const r=validateExpenseCandidate({...base,amount:null,amountText:null,description:null},context);assert.equal(r.valid,false);
  assert.deepEqual(r.missingFields,['monto']);
  assert.equal(validateExpenseCandidate({...base,description:null},context).expense!.description,'Compra en Carrefour');
  assert.equal(validateExpenseCandidate({...base,description:null,merchant:null},{...context,text:'Gasté 35000 con Visa crédito'}).expense!.description,'Gasto en Supermercado');
 });
 await t.test('monto inválido, cero y monto sin evidencia',()=>{
  for(const amount of ['0','-1','35000.111','123456'])assert.equal(validateExpenseCandidate({...base,amount},context).valid,false);
 });
 await t.test('evidencia no puede recortar un decimal para inventar otro monto',()=>{
  assert.equal(validateExpenseCandidate({...base,amount:'1234',amountText:'1234'},{...context,text:context.text.replace('35000','1234.56')}).valid,false);
 });
 await t.test('categorías libres/inactivas rechazadas y categoría faltante',()=>{
  for(const category of ['Inventada',null])assert.equal(validateExpenseCandidate({...base,category},context).valid,false);
  assert.equal(validateExpenseCandidate(base,{...context,categories:[{...category,active:false}]}).valid,false);
 });
 await t.test('tarjeta inexistente, ambigua e inactiva',()=>{
  assert.equal(validateExpenseCandidate({...base,card:'Mastercard'},{...context,text:context.text.replace('Visa','Mastercard')}).valid,false);
  assert.equal(validateExpenseCandidate(base,{...context,cards:[card,{...card,id:randomUUID(),name:'Visa banco'}]}).valid,false);
  assert.equal(validateExpenseCandidate(base,{...context,cards:[{...card,active:false}]}).valid,false);
 });
 await t.test('Visa no implica crédito; efectivo con tarjeta incoherente; nullable sin inventar',()=>{
  const r=validateExpenseCandidate({...base,paymentMethod:null,paymentMethodText:null},{...context,text:'Gasté 35000 en Carrefour con Visa'});
  assert.equal(r.valid,false);assert.ok(r.missingFields.includes('medio de pago'));
  assert.equal(validateExpenseCandidate({...base,paymentMethod:'cash',paymentMethodText:'efectivo'},{...context,text:'Gasté 35000 en Carrefour con Visa efectivo'}).valid,false);
  const cash=validateExpenseCandidate({...base,card:null,paymentMethod:'cash',paymentMethodText:'efectivo'},{...context,text:'Gasté 35000 en Carrefour en efectivo'});
  assert.equal(cash.valid,true);assert.equal(cash.expense!.cardId,null);
  // Crédito sin tarjeta: si hay tarjetas activas utilizables se pregunta cuál; si no hay, se registra sin tarjeta.
  const noCard=validateExpenseCandidate({...base,card:null,paymentMethodText:'crédito'},{...context,text:'Gasté 35000 en Carrefour con tarjeta crédito'});
  assert.equal(noCard.valid,false);assert.deepEqual(noCard.missingFields,['tarjeta']);
  assert.equal(validateExpenseCandidate({...base,card:null,paymentMethodText:'crédito'},{...context,text:'Gasté 35000 en Carrefour con tarjeta crédito',cards:[{...card,cardType:'debit_card'}]}).valid,true);
 });
 await t.test('tipo configurado de la tarjeta decide crédito/débito; nunca contradice el mensaje',()=>{
  const plain={...base,paymentMethod:null,paymentMethodText:null},text='Gasté 35000 en Carrefour con Visa';
  const credit=validateExpenseCandidate(plain,{...context,text,cards:[{...card,cardType:'credit_card'}]});
  assert.equal(credit.valid,true);assert.equal(credit.expense!.paymentMethod,'credit_card');assert.equal(credit.candidate.paymentMethod,'credit_card');
  assert.equal(validateExpenseCandidate(plain,{...context,text,cards:[{...card,cardType:'debit_card'}]}).expense!.paymentMethod,'debit_card');
  const conflict=validateExpenseCandidate({...base,paymentMethod:'debit_card',paymentMethodText:'débito'},{...context,text:'Gasté 35000 en Carrefour con Visa débito',cards:[{...card,cardType:'credit_card'}]});
  assert.equal(conflict.valid,false);assert.ok(conflict.validationErrors.includes('el medio de pago no coincide con el tipo de la tarjeta'));
  assert.equal(validateExpenseCandidate({...base,paymentMethod:'cash',paymentMethodText:'efectivo'},{...context,text:'Gasté 35000 en Carrefour con Visa efectivo',cards:[{...card,cardType:'credit_card'}]}).valid,false);
  assert.equal(validateExpenseCandidate(plain,{...context,text,cards:[{...card,cardType:'credit_card',active:false}]}).valid,false);
  assert.equal(validateExpenseCandidate(plain,{...context,text,cards:[{...card,cardType:'credit_card'},{...card,id:randomUUID(),name:'Visa banco',cardType:'credit_card'}]}).valid,false);
  // Medio adivinado por el modelo desde el nombre de la tarjeta: se descarta y decide el tipo configurado.
  const guessed={...base,paymentMethod:'credit_card' as const,paymentMethodText:'Visa'};
  assert.equal(validateExpenseCandidate(guessed,{...context,text,cards:[{...card,cardType:'debit_card'}]}).expense!.paymentMethod,'debit_card');
  assert.equal(validateExpenseCandidate(guessed,{...context,text}).valid,false);
  assert.ok(validateExpenseCandidate({...guessed,card:null},{...context,text:'Gasté 35000 en Carrefour'}).missingFields.includes('medio de pago'));
  // Con una palabra de pago en el texto, un respaldo incorrecto sigue siendo error.
  assert.equal(validateExpenseCandidate(guessed,{...context,text:text+' débito',cards:[{...card,cardType:'debit_card'}]}).valid,false);
 });
 await t.test('moneda familiar y explícita sin depender del modelo',()=>{
  const usd=validateExpenseCandidate({...base,currency:'USD',currencyText:'USD'},{...context,text:context.text+' USD'});
  assert.equal(usd.valid,true);assert.equal(usd.expense!.currency,'USD');
  assert.equal(validateExpenseCandidate({...base,currency:'CHF',currencyText:'CHF'},{...context,text:context.text+' CHF'}).expense!.currency,'CHF');
  assert.equal(validateExpenseCandidate(base,{...context,defaultCurrency:'UYU'}).expense!.currency,'UYU');
  assert.equal(validateExpenseCandidate(base,{...context,text:context.text+' USD'}).valid,false);
  assert.equal(validateExpenseCandidate({...base,currency:'USD',currencyText:null},context).valid,false);
 });
 await t.test('monedas explícitas contradictorias no pueden ignorarse',()=>{
  assert.equal(validateExpenseCandidate({...base,currency:'USD',currencyText:'USD'},{...context,text:context.text+' USD o EUR'}).valid,false);
  assert.equal(validateExpenseCandidate({...base,currency:'USD',currencyText:'USD'},{...context,text:context.text+' USD dólares'}).valid,true);
 });
 await t.test('fechas contradictorias o inválidas no pueden omitirse',()=>{
  for(const text of ['hoy o ayer','hoy o 31/02','08/10 o 09/10']){
   const dateText=text.split(' o ')[0];
   assert.equal(validateExpenseCandidate({...base,dateText},{...context,text:context.text+' '+text}).valid,false);
  }
  const same=validateExpenseCandidate({...base,dateText:'hoy'},{...context,text:context.text+' hoy 11/10'});
  assert.equal(same.valid,true);
 });
 await t.test('decimal 1234.56, coma y miles argentinos',()=>{
  for(const [input,expected] of [['1234.56','1234.56'],['1234,56','1234.56'],['1.234,56','1234.56'],['35.000','35000.00']]){
   assert.equal(normalizeTextAmount(input),expected);
   const r=validateExpenseCandidate({...base,amount:expected,amountText:input},{...context,text:context.text.replace('35000',input)});
   assert.equal(r.valid,true);assert.equal(r.expense!.amount,expected);
  }
 });
 await t.test('montos coloquiales: mil, k y lucas',()=>{
  for(const [input,expected] of [['15 mil','15000.00'],['15mil','15000.00'],['15k','15000.00'],['1,5 mil','1500.00'],['2 lucas','2000.00'],['$15 mil','15000.00'],['u$s 100','100.00']])
   assert.equal(normalizeTextAmount(input),expected,input);
  for(const input of ['15 milanesas','mil','k'])assert.equal(normalizeTextAmount(input),null,input);
  const r=validateExpenseCandidate({...base,amount:'15000',amountText:'15 mil'},{...context,text:'Gasté 15 Mil en Carrefour con Visa crédito'});
  assert.equal(r.valid,true);assert.equal(r.expense!.amount,'15000.00');
  assert.equal(validateExpenseCandidate({...base,amount:'15',amountText:'15 mil'},{...context,text:'Gasté 15 mil en Carrefour con Visa crédito'}).valid,false);
 });
 await t.test('pesos y $ son moneda local; u$s es USD explícito',()=>{
  const text='Gasté 35000 pesos en Carrefour con Visa crédito';
  assert.equal(validateExpenseCandidate({...base,currency:'ARS',currencyText:'pesos'},{...context,text}).expense!.currency,'ARS');
  assert.equal(validateExpenseCandidate({...base,currency:'ARS',currencyText:'pesos uruguayos'},{...context,text:text.replace('pesos','pesos uruguayos')}).valid,false);
  assert.equal(validateExpenseCandidate({...base,currency:'ARS',currencyText:'$',amountText:'35000'},{...context,text:'Gasté $35000 en Carrefour con Visa crédito'}).valid,true);
  assert.equal(validateExpenseCandidate({...base,currency:'USD',currencyText:'$'},{...context,text:'Gasté $35000 en Carrefour con Visa crédito'}).valid,false);
  const usdText='Gasté u$s 35000 en Carrefour con Visa crédito';
  assert.equal(validateExpenseCandidate(base,{...context,text:usdText}).valid,false);
  assert.equal(validateExpenseCandidate({...base,currency:'USD',currencyText:'u$s'},{...context,text:usdText}).expense!.currency,'USD');
 });
 await t.test('transferencia conjugada; Mercado Pago, MP y QR son billetera, no tarjeta',()=>{
  const transfer=validateExpenseCandidate({...base,card:null,paymentMethod:'transfer',paymentMethodText:'transferí'},{...context,text:'Le transferí 35000 a Carrefour'});
  assert.equal(transfer.valid,true);assert.equal(transfer.expense!.paymentMethod,'transfer');
  const mpCard={id:randomUUID(),name:'mercado pago',active:false,cardType:'debit_card' as const};
  for(const word of ['mercado pago','Mercado Pago','MP','QR']){
   const r=validateExpenseCandidate({...base,card:null,paymentMethod:'wallet',paymentMethodText:word},{...context,text:'Gasté 35000 en Carrefour con '+word,cards:[card,mpCard]});
   assert.equal(r.valid,true,word);assert.equal(r.expense!.paymentMethod,'wallet');assert.equal(r.expense!.cardId,null);
  }
  // Una tarjeta real mencionada sigue sin poder desaparecer.
  assert.equal(validateExpenseCandidate({...base,card:null,paymentMethod:'wallet',paymentMethodText:'mercado pago'},{...context,text:'Gasté 35000 con Visa y mercado pago'}).valid,false);
 });
 await t.test('hoy, ayer, ISO, día/mes y fecha en español; sin desplazamiento UTC',()=>{
  assert.equal(referenceDate(new Date('2026-10-12T01:00:00Z')),'2026-10-11');
  assert.equal(resolveDate('ayer','2026-01-01'),'2025-12-31');
  assert.equal(resolveDate('mañana','2026-12-31'),'2027-01-01');
  assert.equal(validateExpenseCandidate({...base,dateText:'lunes'},{...context,text:context.text+' el lunes'}).valid,false);
  for(const date of ['2026-10-08','08/10','8 de octubre'])assert.equal(resolveDate(date,'2026-10-11'),'2026-10-08');
  assert.equal(resolveDate('31/02','2026-10-11'),null);
  const r=validateExpenseCandidate({...base,dateText:'08/10'},{...context,text:context.text+' el 08/10'});
  assert.equal(r.expense!.date,'2026-10-08');
  assert.equal(validateExpenseCandidate(base,{...context,text:context.text+' ayer'}).expense!.date,'2026-10-10');
 });
 await t.test('JSON inválido, campos incompatibles y Gemini no configurado',async()=>{
  for(const value of [null,{},[],{...base,amount:1234},{...base,paymentMethod:'fake'},{...base,reportedByMemberId:member.id}])assert.throws(()=>parseInterpretation(value));
  const previous=process.env.GEMINI_API_KEY;delete process.env.GEMINI_API_KEY;
  try{await assert.rejects(geminiInterpreter()(context));}finally{if(previous!==undefined)process.env.GEMINI_API_KEY=previous;}
  process.env.GEMINI_API_KEY??='test';
  for(const [failure,kind] of [[{status:503},'transient'],[{status:429},'transient'],[new Error('timeout'),'transient'],[{status:400},'failed'],[{status:403},'failed']] as const)
   await assert.rejects(geminiInterpreter(async()=>{throw failure;})(context),(e:any)=>e instanceof InterpretationError&&e.message===kind);
  const previousModel=process.env.GEMINI_MODEL;process.env.GEMINI_MODEL='saturado, respaldo';
  try{
   const used:string[]=[];
   assert.deepEqual(await geminiInterpreter(async p=>{used.push(p.model);if(p.model==='saturado')throw {status:503};return {text:JSON.stringify(base)};})(context),base);
   assert.deepEqual(used,['saturado','respaldo']);
   used.length=0;
   await assert.rejects(geminiInterpreter(async p=>{used.push(p.model);throw {status:400};})(context),(e:any)=>e.message==='failed');
   assert.deepEqual(used,['saturado']);
   // El detalle técnico permite diagnosticar sin guardar el texto.
   await assert.rejects(geminiInterpreter(async()=>{throw {status:404};})(context),(e:any)=>e.message==='failed'&&e.detail==='http_404');
   await assert.rejects(geminiInterpreter(async()=>{throw {status:503};})(context),(e:any)=>e.message==='transient'&&e.detail==='http_503');
   await assert.rejects(geminiInterpreter(async()=>({text:'{x'}))(context),(e:any)=>e.message==='invalid_output'&&e.detail==='json');
  }finally{if(previousModel===undefined)delete process.env.GEMINI_MODEL;else process.env.GEMINI_MODEL=previousModel;}
  if(previous===undefined)delete process.env.GEMINI_API_KEY;
 });

 await t.test('adaptador Gemini: JSON inválido y esquema dinámico sin catálogos ficticios',async()=>{
  const previous=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY=randomBytes(32).toString('hex');
  try{
   await assert.rejects(geminiInterpreter(async()=>({text:'{invalid'}))(context));
   await assert.rejects(geminiInterpreter(async()=>({text:JSON.stringify({...base,amount:5})}))(context));
   let checked=false;
   const interpreted=await geminiInterpreter(async params=>{
    const content=JSON.parse(params.contents as string);
    assert.deepEqual(content.categories,['Supermercado']);assert.deepEqual(content.cards,['Visa']);
    assert.equal(params.config!.responseMimeType,'application/json');checked=true;
    return {text:JSON.stringify(base)};
   })({...context,categories:[category,{id:randomUUID(),name:'Inactiva',active:false}],cards:[card,{id:randomUUID(),name:'Inactiva',active:false,cardType:null}]});
   assert.equal(checked,true);assert.deepEqual(interpreted,base);
  }finally{if(previous!==undefined)process.env.GEMINI_API_KEY=previous;else delete process.env.GEMINI_API_KEY;}
 });
 await t.test('envío: celular argentino 549 se envía sin el 9; otros números sin cambios',()=>{
  assert.equal(recipientNumber('5493512010915'),'543512010915');
  assert.equal(recipientNumber('5491144445555'),'541144445555');
  for(const n of ['541144445555','14155550123','598991234567','549351201091'])assert.equal(recipientNumber(n),n);
 });
 await t.test('estado del token de Meta: permanente, temporal, por vencer y vencido',async()=>{
  const previous=process.env.WHATSAPP_ACCESS_TOKEN;process.env.WHATSAPP_ACCESS_TOKEN='test-token';
  const now=Date.parse('2026-10-15T12:00:00Z'),fake=(body:unknown)=>(async()=>({json:async()=>body})) as unknown as typeof fetch;
  try{
   assert.equal(await metaTokenStatus(now,fake({data:{is_valid:true,expires_at:0}})),'never');
   assert.equal(await metaTokenStatus(now,fake({data:{is_valid:true,expires_at:now/1000+30*86400}})),'ok');
   assert.equal(await metaTokenStatus(now,fake({data:{is_valid:true,expires_at:now/1000+3600}})),'expires_soon');
   assert.equal(await metaTokenStatus(now,fake({error:{code:190}})),'expired');
   assert.equal(await metaTokenStatus(now,fake({data:{is_valid:false}})),'expired');
   assert.equal(await metaTokenStatus(now,(async()=>{throw new Error();}) as unknown as typeof fetch),'unknown');
  }finally{if(previous===undefined)delete process.env.WHATSAPP_ACCESS_TOKEN;else process.env.WHATSAPP_ACCESS_TOKEN=previous;}
 });
 await t.test('teléfonos: solo formato, sin prefijos inventados',()=>{
  assert.equal(normalizePhone('+54 (9) 11-4444-5555'),'5491144445555');
  assert.equal(normalizePhone('1144445555'),'1144445555');
  assert.equal(normalizePhone('usuario'),null);assert.equal(normalizePhone('54911x44445555'),null);
 });
 await t.test('HMAC SHA256 firma válida, alterada y ausente',()=>{
  const secret=randomBytes(32).toString('hex'),raw=Buffer.from('{"text":"hola"}');
  const sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  assert.equal(validSignature(raw,sig,secret),true);
  assert.equal(validSignature(Buffer.from('{"text":"otro"}'),sig,secret),false);
  assert.equal(validSignature(raw,undefined,secret),false);
 });
});

test('WhatsApp real: webhook firmado, PostgreSQL aislado, idempotencia y errores',{timeout:90000},async(t)=>{
 const db=await isolatedDatabase();let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await migrate(db.pool);await seed(db.pool);await migrate(db.pool);
  const m=(await db.pool.query('INSERT INTO appgastos.family_members(family_id,name,phone_number) VALUES($1,$2,$3) RETURNING id',[INITIAL_FAMILY_ID,'Ana','+54 (9) 11-4444-5555'])).rows[0];
  const k=(await db.pool.query('INSERT INTO appgastos.cards(family_id,name) VALUES($1,$2) RETURNING id',[INITIAL_FAMILY_ID,'Visa'])).rows[0];
  let extraction:unknown=base,failInterpret=false,transientInterpret=false,calls=0;
  const replies:{to:string;text:string}[]=[];
  const interpreter=async()=>{calls++;if(failInterpret)throw new Error();if(transientInterpret)throw new InterpretationError('transient');return extraction as Interpretation;};
  const send=async(to:string,text:string)=>{replies.push({to,text});};
  const proc=whatsappProcessor(db.pool,interpreter,send);
  const incoming=async(id:string,text=context.text,from='5491144445555',type='text')=>{
   await enqueue(db.pool,INITIAL_FAMILY_ID,[{id,sender:from,text:type==='text'?text:null,type,receivedAt:new Date('2026-10-11T15:00:00Z')}]);
   await proc.processNext();await proc.replyNext();
   return (await db.pool.query('SELECT * FROM appgastos.whatsapp_messages WHERE message_id=$1',[id])).rows[0];
  };
  await t.test('persistencia real source whatsapp, integrante por teléfono y respuesta después de COMMIT',async()=>{
   const r=await incoming('complete');assert.equal(r.outcome,'registered');assert.equal(r.reply_state,'sent');assert.equal(r.text_body,null);
   const e=(await db.pool.query("SELECT *,to_char(date,'YYYY-MM-DD') date_only FROM appgastos.expenses WHERE id=$1",[r.expense_id])).rows[0];
   assert.equal(e.source,'whatsapp');assert.equal(e.reported_by_member_id,m.id);assert.equal(e.card_id,k.id);assert.equal(e.amount,'35000.00');assert.equal(e.date_only,'2026-10-11');
   assert.match(replies.at(-1)!.text,/^✅ Registrado: /);assert.equal(replies.at(-1)!.to,'5491144445555');
  });
  await t.test('tarjeta con tipo configurado registra sin crédito/débito en el mensaje',async()=>{
   const typed=(await db.pool.query("INSERT INTO appgastos.cards(family_id,name,card_type) VALUES($1,'Naranja','credit_card') RETURNING id",[INITIAL_FAMILY_ID])).rows[0];
   extraction={...base,card:'Naranja',paymentMethod:null,paymentMethodText:null};
   try{
    const r=await incoming('typed-card','Gasté 35000 en Carrefour con Naranja');assert.equal(r.outcome,'registered');
    const e=(await db.pool.query('SELECT payment_method,card_id,source FROM appgastos.expenses WHERE id=$1',[r.expense_id])).rows[0];
    assert.equal(e.payment_method,'credit_card');assert.equal(e.card_id,typed.id);assert.equal(e.source,'whatsapp');
    extraction={...base,card:'Naranja',paymentMethod:'debit_card',paymentMethodText:'débito'};
    // Tipo contradictorio: no registra; abre conversación y vuelve a preguntar el medio de pago.
    const conflict=await incoming('typed-card-conflict','Gasté 35000 en Carrefour con Naranja débito');
    assert.equal(conflict.outcome,'question');assert.equal(conflict.expense_id,null);
    assert.match(replies.at(-1)!.text,/no coincide con el tipo de la tarjeta.*¿Cómo pagaste\?/);
    assert.equal((await incoming('typed-card-cancel','cancelar')).outcome,'cancelled');
   }finally{extraction=base;}
  });
  await t.test('duplicados, concurrencia y reinicio no crean otro gasto ni reenvían respuesta',async()=>{
   const before=(await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n;
   await incoming('complete');
   const duplicate={id:'concurrent',sender:'5491144445555',text:context.text,type:'text',receivedAt:new Date()};
   await Promise.all([enqueue(db.pool,INITIAL_FAMILY_ID,[duplicate]),enqueue(db.pool,INITIAL_FAMILY_ID,[duplicate])]);
   const another=whatsappProcessor(db.pool,interpreter,send);
   await Promise.all([proc.processNext(),another.processNext()]);await another.replyNext();
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,before+1);
   assert.equal(await another.processNext(),false);
   const count=replies.length;assert.equal(await another.replyNext(),false);assert.equal(replies.length,count);
  });
  await t.test('eliminar el gasto no borra idempotencia',async()=>{
   await db.pool.query("DELETE FROM appgastos.expenses WHERE id=(SELECT expense_id FROM appgastos.whatsapp_messages WHERE message_id='concurrent')");
   const count=(await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n;
   await incoming('concurrent');
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,count);
  });
  await t.test('no autorizado, inactivo y teléfono ambiguo no llaman Gemini ni crean integrantes',async()=>{
   const before=calls;assert.equal((await incoming('unauthorized',context.text,'5491199999999')).outcome,'unauthorized');assert.equal(calls,before);
   await db.pool.query('UPDATE appgastos.family_members SET active=false WHERE id=$1',[m.id]);
   assert.equal((await incoming('inactive-member')).outcome,'unauthorized');
   await db.pool.query('UPDATE appgastos.family_members SET active=true WHERE id=$1',[m.id]);
   const duplicate=(await db.pool.query('INSERT INTO appgastos.family_members(family_id,name,phone_number) VALUES($1,$2,$3) RETURNING id',[INITIAL_FAMILY_ID,'Otro','5491144445555'])).rows[0];
   assert.equal((await incoming('ambiguous-member')).outcome,'unauthorized');
   await db.pool.query('DELETE FROM appgastos.family_members WHERE id=$1',[duplicate.id]);assert.equal(calls,before);
  });
  await t.test('monto faltante, categoría inválida y medio desconocido no registran: preguntan',async()=>{
   const before=(await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n;
   for(const [id,patch,question] of [['no-amount',{amount:null,amountText:null},/¿Cuánto gastaste\?/],['no-category',{category:'Libre'},/¿En qué categoría lo cargo\?/],
    ['no-payment',{paymentMethod:null,paymentMethodText:null,card:null},/¿Cómo pagaste\?/]] as const){
    extraction={...base,...patch};
    const text=id==='no-payment'?'Gasté 35000 en Carrefour':context.text;
    const r=await incoming(id,text);assert.equal(r.outcome,'question',id);assert.equal(r.expense_id,null);assert.match(replies.at(-1)!.text,question);
    assert.equal((await incoming(id+'-cancel','cancelar')).outcome,'cancelled');
   }
   extraction=base;
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,before);
  });
  await t.test('Gemini fallido y salida inválida producen error controlado',async()=>{
   failInterpret=true;const down=await incoming('ai-down');failInterpret=false;
   assert.equal(down.outcome,'interpretation_error');assert.equal(down.last_error,'interpretation_unknown');
   extraction={amount:5};const invalid=await incoming('ai-invalid');extraction=base;
   assert.equal(invalid.outcome,'interpretation_error');assert.equal(invalid.last_error,'interpretation_invalid_output');
   assert.doesNotMatch(replies.at(-1)!.text,/Registrado:/);
  });
  await t.test('Gemini con fallo pasajero reintenta y solo informa al agotar intentos',async()=>{
   transientInterpret=true;
   try{
    const first=await incoming('ai-busy');
    assert.equal(first.state,'pending');assert.equal(first.reply_text,null);assert.equal(first.last_error,'interpretation_retry');
    for(let n=0;n<4;n++){await db.pool.query("UPDATE appgastos.whatsapp_messages SET next_attempt_at=now() WHERE message_id='ai-busy'");await proc.processNext();}
    const last=(await db.pool.query("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='ai-busy'")).rows[0];
    assert.equal(last.state,'completed');assert.equal(last.outcome,'interpretation_error');assert.equal(last.attempts,5);
    assert.equal(last.expense_id,null);assert.match(last.reply_text,/no está disponible/);
    await proc.replyNext();assert.match(replies.at(-1)!.text,/no está disponible/);
   }finally{transientInterpret=false;}
  });
  await t.test('un mensaje que siempre falla se descarta a los 5 intentos y no bloquea al siguiente del remitente',async()=>{
   // Falla la transacción de commit (bloqueo de la fila); el resto del pool es real.
   const broken=new Proxy(db.pool,{get(target:any,key){
    if(key!=='connect')return typeof target[key]==='function'?target[key].bind(target):target[key];
    return async()=>{const c=await target.connect();const q=c.query.bind(c),release=c.release.bind(c);c.release=(e?:any)=>{c.query=q;c.release=release;release(e);};c.query=(sql:any,...a:any[])=>String(sql).includes('FOR UPDATE')&&String(sql).includes('whatsapp_messages')?Promise.reject(new Error('boom')):q(sql,...a);return c;};
   }}) as typeof db.pool;
   const bad=whatsappProcessor(broken,interpreter,send);
   await enqueue(db.pool,INITIAL_FAMILY_ID,[{id:'stuck',sender:'5491144445555',text:context.text,type:'text',receivedAt:new Date('2026-10-11T15:00:00Z')},
    {id:'after-stuck',sender:'5491144445555',text:'cancelar',type:'text',receivedAt:new Date('2026-10-11T15:00:01Z')}]);
   for(let n=0;n<5;n++){await db.pool.query("UPDATE appgastos.whatsapp_messages SET next_attempt_at=now() WHERE message_id='stuck'");await bad.processNext();}
   const stuck=(await db.pool.query("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='stuck'")).rows[0];
   assert.equal(stuck.state,'completed');assert.equal(stuck.outcome,'unsupported');assert.equal(stuck.last_error,'processing_failed');assert.equal(stuck.attempts,5);
   await proc.processNext();
   const next=(await db.pool.query("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='after-stuck'")).rows[0];
   assert.equal(next.state,'completed');assert.equal(next.outcome,'nothing_to_cancel');
   await proc.replyNext();await proc.replyNext();
  });
  await t.test('imagen/audio/documento/video nunca se interpretan ni registran',async()=>{
   const before=calls;
   for(const type of ['image','audio','document','video'])assert.equal((await incoming('media-'+type,'caption','5491144445555',type)).outcome,'unsupported');
   assert.equal(calls,before);
  });
  await t.test('fallo real de INSERT revierte todo y no confirma; reintento usa misma idempotencia',async()=>{
   await db.pool.query("CREATE FUNCTION appgastos.fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated test'; END; $$");
   await db.pool.query('CREATE TRIGGER fail_insert BEFORE INSERT ON appgastos.expenses FOR EACH ROW EXECUTE FUNCTION appgastos.fail_test()');
   const count=(await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,repliesBefore=replies.length;
   const r=await incoming('insert-fails');assert.equal(r.state,'pending');assert.equal(r.expense_id,null);assert.equal(replies.length,repliesBefore);
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,count);
   await db.pool.query('DROP TRIGGER fail_insert ON appgastos.expenses');await db.pool.query('DROP FUNCTION appgastos.fail_test()');
   await db.pool.query("UPDATE appgastos.whatsapp_messages SET next_attempt_at=now() WHERE message_id='insert-fails'");
   await proc.processNext();await proc.replyNext();
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,count+1);assert.match(replies.at(-1)!.text,/^✅ Registrado: /);
  });
  await t.test('recepción durable se recupera de un proceso caído con lease vencida',async()=>{
   await enqueue(db.pool,INITIAL_FAMILY_ID,[{id:'crash',sender:'5491144445555',text:context.text,type:'text',receivedAt:new Date()}]);
   const row=await claim(db.pool);assert.equal(row!.message_id,'crash');
   await db.pool.query("UPDATE appgastos.whatsapp_messages SET lease_until=now()-interval '1 second' WHERE message_id='crash'");
   const fresh=whatsappProcessor(db.pool,interpreter,send);await fresh.processNext();await fresh.replyNext();
   assert.equal((await db.pool.query("SELECT outcome FROM appgastos.whatsapp_messages WHERE message_id='crash'")).rows[0].outcome,'registered');
  });
  await t.test('fallo de respuesta se reintenta sin crear otro gasto',async()=>{
   const fresh=whatsappProcessor(db.pool,interpreter,async()=>{throw new Error();});
   await enqueue(db.pool,INITIAL_FAMILY_ID,[{id:'reply-fail',sender:'5491144445555',text:context.text,type:'text',receivedAt:new Date()}]);
   await fresh.processNext();await fresh.replyNext();
   const r=(await db.pool.query("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='reply-fail'")).rows[0];assert.equal(r.outcome,'registered');assert.equal(r.reply_state,'pending');
   const n=(await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n;
   await db.pool.query("UPDATE appgastos.whatsapp_messages SET reply_next_attempt_at=now() WHERE message_id='reply-fail'");
   await proc.replyNext();assert.equal((await db.pool.query('SELECT count(*)::int n FROM appgastos.expenses')).rows[0].n,n);
  });
  const secret=randomBytes(32).toString('hex'),verify=randomBytes(24).toString('hex');
  const app=express();registerWhatsApp(app,db.pool,{secret,verifyToken:verify,phoneNumberId:'123456',familyId:INITIAL_FAMILY_ID,interpret:interpreter,send,startWorker:false});
  app.use(express.json());registerDatabaseApi(app,db.pool,INITIAL_FAMILY_ID);
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const payload=(id:string,type='text')=>JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'123456'},messages:[{id,from:'5491144445555',type,text:{body:context.text}}]}}]}]});
  const post=(body:string,signed=true)=>fetch(url+'/api/whatsapp/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed?'sha256='+createHmac('sha256',secret).update(body).digest('hex'):'sha256='+randomBytes(32).toString('hex')},body});
  await t.test('webhook firma exacta, GET challenge, rechazo antes de persistencia',async()=>{
   assert.equal((await fetch(url+'/api/whatsapp/webhook?'+new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':verify,'hub.challenge':'challenge'}))).status,200);
   assert.equal((await fetch(url+'/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong')).status,403);
   assert.equal((await post(payload('bad-signature'),false)).status,403);
   assert.equal((await db.pool.query("SELECT count(*)::int n FROM appgastos.whatsapp_messages WHERE message_id='bad-signature'")).rows[0].n,0);
   assert.equal((await post('{invalid')).status,400);
   const alien=payload('wrong-receiver').replace('123456','999999');
   assert.equal((await post(alien)).status,200);
   assert.equal((await db.pool.query("SELECT count(*)::int n FROM appgastos.whatsapp_messages WHERE message_id='wrong-receiver'")).rows[0].n,0);
   const statuses=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:'123456'},statuses:[{id:'outgoing',status:'delivered'}]}}]}]});
   assert.equal((await post(statuses)).status,200);

   assert.equal((await post(payload('http-message'))).status,200);
   assert.equal((await post(payload('http-message'))).status,200);
   assert.equal((await db.pool.query("SELECT count(*)::int n FROM appgastos.whatsapp_messages WHERE message_id='http-message'")).rows[0].n,1);
   await proc.processNext();await proc.replyNext();
   const response=await fetch(url+'/api/expenses');const data=await response.json();
   assert.ok(data.expenses.some((e:any)=>e.source==='whatsapp'&&e.reportedByMemberId===m.id));
  });
  await t.test('configuración no expone secretos; simulación no crea gastos',async()=>{
   const r=await fetch(url+'/api/whatsapp/config');const raw=await r.text();assert.ok(!raw.includes(secret));assert.ok(!raw.includes(verify));
   assert.equal((await fetch(url+'/api/whatsapp/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
   assert.equal((await fetch(url+'/api/whatsapp/simulate',{method:'POST'})).status,410);
  });
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await db.stop();}
});
