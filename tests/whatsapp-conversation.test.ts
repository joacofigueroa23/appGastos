import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedDatabase} from './helpers/postgres';
import {migrate} from '../scripts/migrate';
import {seed,INITIAL_FAMILY_ID} from '../scripts/seed';
import {InterpretationError,emptyInterpretation,type Interpretation,type InterpretationContext} from '../src/backend/whatsapp/candidate';
import {applyCandidatePatch,type ExpenseDraft} from '../src/backend/whatsapp/draft';
import {classifyPatch,deterministicAnswer,hasCorrectionMarker,isCancel} from '../src/backend/whatsapp/intent';
import {formatAmount} from '../src/backend/whatsapp/replies';
import {conversationTtlMinutes} from '../src/backend/whatsapp/config';
import {enqueue} from '../src/backend/whatsapp/repository';
import {whatsappProcessor} from '../src/backend/whatsapp/processor';

const FAMILY=INITIAL_FAMILY_ID,ANA='5491144445555',BETO='5491155556666';
const ev=<T,>(value:T,evidence:string|null=null)=>({value,evidence});

test('Conversación: reglas deterministas',async(t)=>{
 await t.test('cancelación solo al empezar el mensaje; marcas de corrección',()=>{
  for(const text of ['cancelar','Cancelá','cancelalo!','no lo cargues','Olvidalo','dejalo'])assert.equal(isCancel(text),true,text);
  for(const text of ['cancelé la tarjeta con 5000','gasté 5000','no'])assert.equal(isCancel(text),false,text);
  for(const text of ['Perdón, fueron 38 mil','No fue Carrefour, fue Disco','me equivoqué','en realidad 40k'])assert.equal(hasCorrectionMarker(text),true,text);
  assert.equal(hasCorrectionMarker('35 mil'),false);
 });
 await t.test('formato argentino de montos; otra moneda con prefijo',()=>{
  assert.equal(formatAmount('35000.00','ARS','ARS'),'$35.000');
  assert.equal(formatAmount('1234.56','ARS','ARS'),'$1.234,56');
  assert.equal(formatAmount('100.00','USD','ARS'),'US$ 100');
  assert.equal(formatAmount('50.50','EUR','ARS'),'EUR 50,50');
 });
 await t.test('TTL centralizado: valor por defecto, configurado e inválido',()=>{
  const previous=process.env.WHATSAPP_CONVERSATION_TTL_MINUTES;
  try{
   delete process.env.WHATSAPP_CONVERSATION_TTL_MINUTES;assert.equal(conversationTtlMinutes(),30);
   process.env.WHATSAPP_CONVERSATION_TTL_MINUTES='5';assert.equal(conversationTtlMinutes(),5);
   for(const bad of ['0','abc','2.5','9999'])process.env.WHATSAPP_CONVERSATION_TTL_MINUTES=bad,assert.equal(conversationTtlMinutes(),30,bad);
  }finally{if(previous===undefined)delete process.env.WHATSAPP_CONVERSATION_TTL_MINUTES;else process.env.WHATSAPP_CONVERSATION_TTL_MINUTES=previous;}
 });
 await t.test('applyCandidatePatch conserva lo no mencionado y limpia derivados',()=>{
  const draft:ExpenseDraft={referenceDate:'2026-10-15',amount:ev('35000.00'),merchant:ev('Carrefour'),description:ev('Compra en Carrefour'),category:ev('cat'),paymentMethod:ev('credit_card'),card:ev('visa'),options:['a']};
  const paid=applyCandidatePatch(draft,{paymentMethod:ev('cash','efectivo')});
  assert.equal(paid.amount!.value,'35000.00');assert.equal(paid.merchant!.value,'Carrefour');assert.equal(paid.card,undefined);assert.equal(paid.options,undefined);
  const moved=applyCandidatePatch(draft,{merchant:ev('Disco','Disco')});
  assert.equal(moved.description,undefined);assert.equal(moved.category!.value,'cat');
  assert.deepEqual(applyCandidatePatch(draft,{},['card']).require,['card']);
  assert.equal(applyCandidatePatch({...draft,require:['card']},{card:ev(null,'ninguna')}).require,undefined);
 });
 await t.test('clasificación: completa, corrige, ignora o detecta otro gasto',()=>{
  const draft:ExpenseDraft={referenceDate:'2026-10-15',amount:ev('35000.00'),merchant:ev('Carrefour')};
  assert.equal(classifyPatch(draft,{paymentMethod:ev('cash')},'efectivo','paymentMethod').intent,'answer');
  assert.equal(classifyPatch(draft,{amount:ev('38000.00')},'Perdón, fueron 38 mil','paymentMethod').intent,'correct');
  const ignored=classifyPatch(draft,{amount:ev('40000.00'),paymentMethod:ev('cash')},'40000 efectivo','paymentMethod');
  assert.equal(ignored.intent,'answer');assert.equal(ignored.patch.amount,undefined);assert.equal(ignored.patch.paymentMethod!.value,'cash');
  assert.equal(classifyPatch(draft,{amount:ev('40000.00')},'40000','paymentMethod').intent,'unknown');
  assert.equal(classifyPatch(draft,{amount:ev('5000.00'),merchant:ev('Farmacia')},'5000 en la farmacia','paymentMethod').intent,'conflict');
  // El campo preguntado nunca cuenta como reemplazo.
  assert.equal(classifyPatch({...draft,card:ev('x')},{card:ev('y')},'Visa','card').intent,'answer');
  // Repetir un dato ya cargado no aporta nada.
  assert.equal(classifyPatch(draft,{merchant:ev('Carrefour')},'Carrefour','paymentMethod').intent,'unknown');
 });
 await t.test('respuestas cortas resueltas sin IA',()=>{
  const catalog={categories:[{id:'c1',name:'Supermercado',active:true},{id:'c2',name:'Otros',active:true}],cards:[{id:'k1',name:'Visa',active:true,cardType:'credit_card' as const},{id:'k2',name:'Visa Galicia',active:true,cardType:'credit_card' as const}]};
  const draft:ExpenseDraft={referenceDate:'2026-10-15',options:['k1','k2',null]};
  const amount=deterministicAnswer('amount','35 mil',draft,catalog);
  assert.equal(amount?.kind,'interpretation');assert.equal((amount as any).raw.amount,'35000.00');
  assert.equal(deterministicAnswer('amount','fueron 35 mil',draft,catalog),null);
  assert.deepEqual(deterministicAnswer('card','ninguna',draft,catalog),{kind:'patch',patch:{card:{value:null,evidence:'ninguna'}}});
  assert.deepEqual(deterministicAnswer('card','2',draft,catalog),{kind:'patch',patch:{card:{value:'k2',evidence:'2'}}});
  assert.deepEqual(deterministicAnswer('card','3',draft,catalog),{kind:'patch',patch:{card:{value:null,evidence:'3'}}});
  assert.equal((deterministicAnswer('paymentMethod','visa galicia crédito',draft,catalog) as any).raw.card,'Visa Galicia');
  assert.equal((deterministicAnswer('paymentMethod','Brubank',draft,catalog) as any).raw.paymentMethod,'wallet');
  assert.equal((deterministicAnswer('category','2',{...draft,options:['c1','c2']},catalog) as any).raw.category,'Otros');
  assert.equal((deterministicAnswer('category','supermercado',draft,catalog) as any).raw.category,'Supermercado');
  assert.equal((deterministicAnswer('date','ayer',draft,catalog) as any).raw.dateText,'ayer');
  assert.equal(deterministicAnswer('paymentMethod','hoy fui al super y pagué con la tarjeta',draft,catalog),null);
 });
});

test('Conversación WhatsApp: PostgreSQL aislado, varios mensajes, un gasto',{timeout:120000},async(t)=>{
 const db=await isolatedDatabase();
 try{
  await migrate(db.pool);await seed(db.pool);
  const q=async(sql:string,args:unknown[]=[])=>(await db.pool.query(sql,args)).rows;
  const ana=(await q('INSERT INTO appgastos.family_members(family_id,name,phone_number) VALUES($1,$2,$3) RETURNING id',[FAMILY,'Ana','+'+ANA]))[0].id as string;
  await q('INSERT INTO appgastos.family_members(family_id,name,phone_number) VALUES($1,$2,$3)',[FAMILY,'Beto',BETO]);
  const card=async(name:string,type:string|null,active=true)=>(await q('INSERT INTO appgastos.cards(family_id,name,card_type,active) VALUES($1,$2,$3,$4) RETURNING id',[FAMILY,name,type,active]))[0].id as string;
  const visa=await card('Visa','credit_card'),mcGalicia=await card('Mastercard Galicia','credit_card'),mcSantander=await card('Mastercard Santander','debit_card');
  const amexUno=await card('Amex Uno','credit_card'),amexDos=await card('Amex Dos','credit_card');await card('Cabal','credit_card',false);
  const category=async(name:string)=>(await q('SELECT id FROM appgastos.categories WHERE family_id=$1 AND name=$2',[FAMILY,name]))[0].id as string;
  const supermercado=await category('Supermercado');

  // Intérprete inyectado: respuestas por texto exacto. Sin entrada → todos los campos null.
  const script=new Map<string,Partial<Interpretation>|(()=>never)>();
  const calls:InterpretationContext[]=[];
  const interpreter=async(ctx:InterpretationContext)=>{
   calls.push(ctx);const entry=script.get(ctx.text);
   if(typeof entry==='function')entry();
   return {...emptyInterpretation(),...(entry as Partial<Interpretation>|undefined)};
  };
  const replies:{to:string;text:string}[]=[];
  const send=async(to:string,text:string)=>{replies.push({to,text});};
  let proc=whatsappProcessor(db.pool,interpreter,send);
  let clock=Date.parse('2026-10-15T15:00:00Z'),seq=0;
  const drain=async()=>{while(await proc.processNext());while(await proc.replyNext());};
  const say=async(text:string,options:{from?:string;at?:number;id?:string}={})=>{
   const id=options.id??'msg-'+(++seq);clock=options.at??clock+1000;
   await enqueue(db.pool,FAMILY,[{id,sender:options.from??ANA,text,type:'text',receivedAt:new Date(),metaTimestamp:new Date(clock)}]);
   await drain();
   return (await q('SELECT * FROM appgastos.whatsapp_messages WHERE message_id=$1',[id]))[0];
  };
  const active=async(member=ana)=>(await q("SELECT * FROM appgastos.whatsapp_conversations WHERE family_id=$1 AND member_id=$2 AND status='active'",[FAMILY,member]))[0];
  const conversation=async(id:string)=>(await q('SELECT * FROM appgastos.whatsapp_conversations WHERE id=$1',[id]))[0];
  const expenses=async()=>(await q('SELECT count(*)::int n FROM appgastos.expenses'))[0].n as number;
  const expense=async(id:string)=>(await q("SELECT *,to_char(date,'YYYY-MM-DD') date_only,amount::text amount_text FROM appgastos.expenses WHERE id=$1",[id]))[0];
  const lastReply=()=>replies.at(-1)!.text;
  const carrefour:Partial<Interpretation>={merchant:'Carrefour',description:'Compra en Carrefour',category:'Supermercado'};

  await t.test('1. mensaje completo registra directo, sin crear conversación',async()=>{
   script.set('Gasté 35 mil en Carrefour con Visa',{...carrefour,amount:'35000',amountText:'35 mil',card:'Visa'});
   const before=(await q('SELECT count(*)::int n FROM appgastos.whatsapp_conversations'))[0].n;
   const r=await say('Gasté 35 mil en Carrefour con Visa');
   assert.equal(r.outcome,'registered');assert.equal(r.conversation_id,null);
   assert.equal((await q('SELECT count(*)::int n FROM appgastos.whatsapp_conversations'))[0].n,before);
   assert.equal(lastReply(),'✅ Registrado: $35.000 en Carrefour · Supermercado · Visa.');
   const e=await expense(r.expense_id);assert.equal(e.card_id,visa);assert.equal(e.payment_method,'credit_card');
  });

  await t.test('2, 3, 4, 5, 7, 29. flujo completo de a una pregunta; un solo gasto confirmado',async()=>{
   script.set('Compré en Carrefour',carrefour);
   const before=await expenses();
   const first=await say('Compré en Carrefour');
   assert.equal(first.outcome,'question');assert.equal(lastReply(),'¿Cuánto gastaste?');
   const c=await active();assert.equal(c.id,first.conversation_id);assert.equal(c.expected_field,'amount');
   assert.equal(c.draft.merchant.value,'Carrefour');assert.equal(c.draft.category.value,supermercado);
   const callsBefore=calls.length;
   const second=await say('35 mil');
   assert.equal(calls.length,callsBefore,'respuesta de monto sin IA');
   assert.equal(second.outcome,'question');assert.equal(second.conversation_id,c.id);
   assert.equal(lastReply(),'¿Cómo pagaste? Efectivo, débito, crédito, transferencia o billetera virtual.');
   assert.equal((await active()).draft.amount.value,'35000.00');assert.equal((await active()).draft.merchant.value,'Carrefour');
   const third=await say('crédito');
   assert.equal(third.outcome,'question');
   // Solo tarjetas activas de crédito o sin tipo; ordenadas; con "Ninguna".
   assert.equal(lastReply(),'¿Con qué tarjeta? 1) Amex Dos  2) Amex Uno  3) Mastercard Galicia  4) Visa  5) Ninguna');
   assert.equal(await expenses(),before,'nada se registra antes de completar');
   const last=await say('Visa');
   assert.equal(calls.length,callsBefore,'todas las respuestas cortas sin IA');
   assert.equal(last.outcome,'registered');assert.equal(last.conversation_id,c.id);
   assert.equal(lastReply(),'✅ Registrado: $35.000 en Carrefour · Supermercado · Visa.');
   assert.equal(await expenses(),before+1);
   const e=await expense(last.expense_id);
   assert.equal(e.source,'whatsapp');assert.equal(e.reported_by_member_id,ana);assert.equal(e.amount_text,'35000.00');
   assert.equal(e.card_id,visa);assert.equal(e.payment_method,'credit_card');assert.equal(e.category_id,supermercado);
   assert.equal(e.description,'Compra en Carrefour');assert.equal(e.merchant,'Carrefour');
   const closed=await conversation(c.id);assert.equal(closed.status,'confirmed');assert.equal(closed.expense_id,e.id);assert.ok(closed.closed_at);
   assert.equal(await active(),undefined);
   assert.equal((await q('SELECT count(*)::int n FROM appgastos.whatsapp_messages WHERE conversation_id=$1',[c.id]))[0].n,4);
  });

  await t.test('4, 6, 7. tarjeta "ninguna" y por número; categoría por número y por nombre; descripción derivada',async()=>{
   script.set('Gasté 5000',{amount:'5000',amountText:'5000'});
   await say('Gasté 5000');assert.equal(lastReply().startsWith('¿Cómo pagaste?'),true);
   await say('débito');assert.equal(lastReply(),'¿Con qué tarjeta? 1) Mastercard Santander  2) Ninguna');
   await say('2');assert.match(lastReply(),/^¿En qué categoría lo cargo\? 1\) Alimentación & Salidas  2\) Educación/);
   const options=(await active()).draft.options as string[];
   const r=await say('12');
   assert.equal(r.outcome,'registered');
   const e=await expense(r.expense_id);
   assert.equal(e.card_id,null);assert.equal(e.payment_method,'debit_card');assert.equal(e.category_id,options[11]);
   const name=(await q('SELECT name FROM appgastos.categories WHERE id=$1',[options[11]]))[0].name;
   assert.equal(e.description,'Gasto en '+name);assert.equal(lastReply(),'✅ Registrado: $5.000 en '+name+'.');
   await say('Gasté 5000');await say('efectivo');
   const byName=await say('supermercado');
   assert.equal(byName.outcome,'registered');assert.equal((await expense(byName.expense_id)).category_id,supermercado);
  });

  await t.test('6. categoría no resoluble vuelve a preguntar',async()=>{
   script.set('Gasté 900 en efectivo',{amount:'900',amountText:'900',paymentMethod:'cash',paymentMethodText:'efectivo',category:'Inventada'});
   const r=await say('Gasté 900 en efectivo');
   assert.equal(r.outcome,'question');assert.match(lastReply(),/^No entendí bien la categoría. ¿En qué categoría/);
   const again=await say('xyz');assert.equal(again.outcome,'unrecognized');assert.match(lastReply(),/^No te entendí bien. ¿En qué categoría/);
   await say('cancelar');
  });

  await t.test('8, 9. correcciones de monto y comercio sobre el mismo borrador',async()=>{
   script.set('Gasté 35 mil en Carrefour',{...carrefour,amount:'35000',amountText:'35 mil'});
   script.set('Perdón, fueron 38 mil',{amount:'38000',amountText:'38 mil'});
   script.set('No fue Carrefour, fue Disco',{merchant:'Disco'});
   const before=await expenses();
   const first=await say('Gasté 35 mil en Carrefour');
   const fixed=await say('Perdón, fueron 38 mil');
   assert.equal(fixed.outcome,'corrected');assert.equal(fixed.conversation_id,first.conversation_id);
   assert.equal(lastReply(),'Corregido. ¿Cómo pagaste? Efectivo, débito, crédito, transferencia o billetera virtual.');
   assert.equal((await active()).draft.amount.value,'38000.00');
   const moved=await say('No fue Carrefour, fue Disco');
   assert.equal(moved.outcome,'corrected');assert.equal((await active()).draft.merchant.value,'Disco');
   const done=await say('efectivo');
   assert.equal(done.outcome,'registered');assert.equal(await expenses(),before+1);
   const e=await expense(done.expense_id);
   assert.equal(e.amount_text,'38000.00');assert.equal(e.merchant,'Disco');assert.equal(e.description,'Compra en Disco');
  });

  await t.test('10. un campo ya cargado sin frase de corrección no se pisa',async()=>{
   script.set('Gasté 35 mil en Carrefour',{...carrefour,amount:'35000',amountText:'35 mil'});
   script.set('40000',{amount:'40000',amountText:'40000'});
   await say('Gasté 35 mil en Carrefour');
   const r=await say('40000');
   assert.equal(r.outcome,'unrecognized');assert.equal((await active()).draft.amount.value,'35000.00');
   await say('cancelar');
  });

  await t.test('11, 12. cancelación, nada para cancelar y nueva conversación posterior',async()=>{
   const before=await expenses();
   const first=await say('Compré en Carrefour');
   const callsBefore=calls.length;
   const cancel=await say('Cancelá');
   assert.equal(cancel.outcome,'cancelled');assert.equal(lastReply(),'Listo, cancelé el gasto pendiente. No se registró nada.');
   assert.equal(calls.length,callsBefore,'cancelar no llama a Gemini');
   const c=await conversation(first.conversation_id);assert.equal(c.status,'cancelled');assert.equal(c.expense_id,null);assert.ok(c.draft.merchant);
   const nothing=await say('cancelar');
   assert.equal(nothing.outcome,'nothing_to_cancel');assert.equal(nothing.conversation_id,null);assert.equal(lastReply(),'No tenés ningún gasto pendiente para cancelar.');
   const again=await say('Compré en Carrefour');
   assert.equal(again.outcome,'question');assert.notEqual(again.conversation_id,first.conversation_id);
   await say('cancelar');assert.equal(await expenses(),before);
  });

  await t.test('13. un segundo gasto con uno pendiente no se mezcla',async()=>{
   script.set('Gasté 35 mil en Carrefour',{...carrefour,amount:'35000',amountText:'35 mil'});
   script.set('Gasté 5000 en la farmacia',{amount:'5000',amountText:'5000',merchant:'farmacia',category:'Salud & Farmacia',description:'Farmacia'});
   await say('Gasté 35 mil en Carrefour');
   const version=(await active()).version;
   const r=await say('Gasté 5000 en la farmacia');
   assert.equal(r.outcome,'pending_conflict');
   assert.equal(lastReply(),'Tenés un gasto pendiente ($35.000 en Carrefour). Respondé la pregunta o escribí "cancelar" para empezar otro.');
   const c=await active();assert.equal(c.draft.amount.value,'35000.00');assert.equal(c.draft.merchant.value,'Carrefour');assert.equal(c.version,version);
   await say('cancelar');
  });

  await t.test('14. tres respuestas incomprensibles cancelan con aviso',async()=>{
   const first=await say('Compré en Carrefour');
   assert.equal((await say('hola')).outcome,'unrecognized');assert.equal((await active()).unknown_count,1);
   assert.equal((await say('qué tal')).outcome,'unrecognized');assert.equal((await active()).unknown_count,2);
   const third=await say('nada');
   assert.equal(third.outcome,'cancelled');assert.match(lastReply(),/^No pude entender las respuestas, así que cancelé/);
   assert.equal((await conversation(first.conversation_id)).status,'cancelled');
  });

  await t.test('15-18. tarjetas: tipo, desambiguación por tipo, ambigua, inactiva',async()=>{
   script.set('Gasté 1000 en Carrefour con Mastercard débito',{...carrefour,amount:'1000',amountText:'1000',card:'Mastercard',paymentMethod:'debit_card',paymentMethodText:'débito'});
   const byType=await say('Gasté 1000 en Carrefour con Mastercard débito');
   assert.equal(byType.outcome,'registered');assert.equal((await expense(byType.expense_id)).card_id,mcSantander);
   script.set('Gasté 1000 en Carrefour con Mastercard',{...carrefour,amount:'1000',amountText:'1000',card:'Mastercard'});
   const noType=await say('Gasté 1000 en Carrefour con Mastercard');
   assert.equal(noType.outcome,'question');assert.match(lastReply(),/^No entendí bien la tarjeta. ¿Con qué tarjeta\?|^No entendí bien la tarjeta. ¿Cómo pagaste\?/);
   await say('cancelar');
   script.set('Gasté 1000 en Carrefour con Amex crédito',{...carrefour,amount:'1000',amountText:'1000',card:'Amex',paymentMethod:'credit_card',paymentMethodText:'crédito'});
   const ambiguous=await say('Gasté 1000 en Carrefour con Amex crédito');
   assert.equal(ambiguous.outcome,'question');assert.equal(lastReply(),'No entendí bien la tarjeta. ¿Con qué tarjeta? 1) Amex Dos  2) Amex Uno  3) Mastercard Galicia  4) Visa  5) Ninguna');
   const chosen=await say('Amex Uno');
   assert.equal(chosen.outcome,'registered');assert.equal((await expense(chosen.expense_id)).card_id,amexUno);
   script.set('Gasté 1000 en Carrefour con Cabal crédito',{...carrefour,amount:'1000',amountText:'1000',card:'Cabal',paymentMethod:'credit_card',paymentMethodText:'crédito'});
   const inactive=await say('Gasté 1000 en Carrefour con Cabal crédito');
   assert.equal(inactive.outcome,'question');assert.match(lastReply(),/^No entendí bien la tarjeta. ¿Con qué tarjeta\?/);
   assert.doesNotMatch(lastReply(),/Cabal/);
   const none=await say('ninguna');
   assert.equal(none.outcome,'registered');const e=await expense(none.expense_id);assert.equal(e.card_id,null);assert.equal(e.payment_method,'credit_card');
   void amexDos;void mcGalicia;
  });

  await t.test('19. Brubank, Mercado Pago, MP y QR son billetera sin tarjeta',async()=>{
   for(const word of ['Brubank','Mercado Pago','MP','QR']){
    const text='Gasté 700 en Carrefour con '+word;
    script.set(text,{...carrefour,amount:'700',amountText:'700',paymentMethod:'wallet',paymentMethodText:word});
    const r=await say(text);assert.equal(r.outcome,'registered',word);
    const e=await expense(r.expense_id);assert.equal(e.payment_method,'wallet');assert.equal(e.card_id,null);
   }
   await say('Compré en Carrefour');await say('700');
   const r=await say('brubank');assert.equal(r.outcome,'registered');assert.equal((await expense(r.expense_id)).payment_method,'wallet');
  });

  await t.test('20, 22. expiración por TTL configurado; el siguiente mensaje es una interacción nueva',async()=>{
   const previous=process.env.WHATSAPP_CONVERSATION_TTL_MINUTES;process.env.WHATSAPP_CONVERSATION_TTL_MINUTES='5';
   try{
    const first=await say('Compré en Carrefour');
    const c=await active();assert.equal(new Date(c.expires_at).getTime(),clock+5*60000);
    script.set('35 mil',{amount:'35000',amountText:'35 mil'});
    const callsBefore=calls.length;
    const late=await say('35 mil',{at:clock+6*60000});
    assert.equal((await conversation(first.conversation_id)).status,'expired');
    assert.equal(calls.length,callsBefore+1,'sin conversación activa se interpreta como mensaje nuevo');
    assert.notEqual(late.conversation_id,first.conversation_id);assert.equal(late.outcome,'question');
    assert.equal((await active()).draft.merchant,undefined,'no hereda datos de la conversación vencida');
    await say('cancelar');
   }finally{if(previous===undefined)delete process.env.WHATSAPP_CONVERSATION_TTL_MINUTES;else process.env.WHATSAPP_CONVERSATION_TTL_MINUTES=previous;}
  });

  await t.test('21. conversación que cruza la medianoche usa la fecha del primer mensaje',async()=>{
   // 23:50 del 15/10 en Buenos Aires = 02:50Z del 16/10.
   await say('Compré en Carrefour',{at:Date.parse('2026-10-16T02:50:00Z')});
   await say('35 mil',{at:Date.parse('2026-10-16T03:05:00Z')});
   const r=await say('efectivo',{at:Date.parse('2026-10-16T03:10:00Z')});
   assert.equal(r.outcome,'registered');assert.equal((await expense(r.expense_id)).date_only,'2026-10-15');
  });

  await t.test('23. Gemini falla: borrador intacto; error pasajero reintenta sin aplicar dos veces',async()=>{
   await say('Compré en Carrefour');
   const before=await active();
   script.set('pagué con algo raro',()=>{throw new Error('down');});
   const failed=await say('pagué con algo raro');
   assert.equal(failed.outcome,'interpretation_error');assert.equal(failed.last_error,'interpretation_unknown');
   assert.equal(lastReply(),'No pude entender ese mensaje. El gasto pendiente sigue guardado. ¿Cuánto gastaste?');
   const after=await active();assert.equal(after.id,before.id);assert.deepEqual({...after.draft,options:undefined},{...before.draft,options:undefined});assert.equal(after.unknown_count,0);
   let busy=true;
   script.set('fueron unos 35 mil',()=>{if(busy)throw new InterpretationError('transient','http_503');return undefined as never;});
   const pending=await say('fueron unos 35 mil');
   assert.equal(pending.state,'pending');assert.equal(pending.reply_text,null);assert.equal(pending.last_error,'interpretation_retry');
   assert.equal((await active()).version,after.version,'el borrador no cambió');
   busy=false;script.set('fueron unos 35 mil',{amount:'35000',amountText:'35 mil'});
   await q("UPDATE appgastos.whatsapp_messages SET next_attempt_at=now() WHERE message_id=$1",[pending.message_id]);
   await drain();
   const done=(await q('SELECT * FROM appgastos.whatsapp_messages WHERE message_id=$1',[pending.message_id]))[0];
   assert.equal(done.outcome,'question');assert.equal((await active()).draft.amount.value,'35000.00');assert.equal((await active()).expected_field,'paymentMethod');
   await say('cancelar');
  });

  await t.test('24. mensaje duplicado: un patch, una pregunta',async()=>{
   await say('Compré en Carrefour');
   const version=(await active()).version,count=replies.length;
   const duplicate={id:'dup-1',sender:ANA,text:'35 mil',type:'text',receivedAt:new Date(),metaTimestamp:new Date(clock+=1000)};
   await Promise.all([enqueue(db.pool,FAMILY,[duplicate]),enqueue(db.pool,FAMILY,[duplicate])]);
   await drain();await enqueue(db.pool,FAMILY,[duplicate]);await drain();
   assert.equal(replies.length,count+1);assert.equal((await active()).version,version+1);
   await say('cancelar');
  });

  await t.test('25, 26. mensajes rápidos y fuera de orden se procesan en orden de Meta',async()=>{
   await say('Compré en Carrefour');
   const t0=clock;
   // Llega primero el posterior ("efectivo") y después el anterior ("35 mil").
   await enqueue(db.pool,FAMILY,[{id:'late-2',sender:ANA,text:'efectivo',type:'text',receivedAt:new Date(),metaTimestamp:new Date(t0+2000)}]);
   await enqueue(db.pool,FAMILY,[{id:'late-1',sender:ANA,text:'35 mil',type:'text',receivedAt:new Date(),metaTimestamp:new Date(t0+1000)}]);
   clock=t0+2000;
   const other=whatsappProcessor(db.pool,interpreter,send);
   await Promise.all([proc.processNext(),other.processNext()]);await drain();
   const [one,two]=[(await q("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='late-1'"))[0],(await q("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='late-2'"))[0]];
   assert.equal(one.outcome,'question');assert.equal(two.outcome,'registered');
   assert.ok(new Date(one.completed_at)<=new Date(two.completed_at));
   const e=await expense(two.expense_id);assert.equal(e.amount_text,'35000.00');assert.equal(e.payment_method,'cash');
  });

  await t.test('25. la conversación cambia durante la llamada a Gemini: se reprocesa, sin aplicar un parche viejo',async()=>{
   await say('Compré en Carrefour');
   const c=await active();let changed=false;
   // Simula otra escritura sobre la misma conversación mientras Gemini responde.
   script.set('creo que fueron 35 mil',{amount:'35000',amountText:'35 mil'});
   const original=script.get('creo que fueron 35 mil');
   script.set('creo que fueron 35 mil',(()=>{throw new Error('unreachable');}) as never);
   const wrapped=async(ctx:InterpretationContext)=>{
    if(ctx.text==='creo que fueron 35 mil'&&!changed){changed=true;await q('UPDATE appgastos.whatsapp_conversations SET version=version+1 WHERE id=$1',[c.id]);}
    return {...emptyInterpretation(),...(original as Partial<Interpretation>)};
   };
   const racing=whatsappProcessor(db.pool,wrapped,send);
   await enqueue(db.pool,FAMILY,[{id:'race-1',sender:ANA,text:'creo que fueron 35 mil',type:'text',receivedAt:new Date(),metaTimestamp:new Date(clock+=1000)}]);
   await racing.processNext();
   const first=(await q("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='race-1'"))[0];
   assert.equal(first.state,'pending');assert.equal(first.last_error,'conversation_changed');assert.equal(first.reply_text,null);
   await racing.processNext();await racing.replyNext();
   const done=(await q("SELECT * FROM appgastos.whatsapp_messages WHERE message_id='race-1'"))[0];
   assert.equal(done.outcome,'question');assert.equal(done.attempts,2);
   const after=await active();assert.equal(after.draft.amount.value,'35000.00');assert.equal(after.version,c.version+2);
   await say('cancelar');
  });

  await t.test('27. reinicio de Express con conversación pendiente',async()=>{
   await say('Compré en Carrefour');await say('35 mil');
   proc=whatsappProcessor(db.pool,interpreter,send);
   const r=await say('efectivo');assert.equal(r.outcome,'registered');
  });

  await t.test('28. número no autorizado: sin conversación y sin Gemini; integrante desactivado → error',async()=>{
   const callsBefore=calls.length,conversations=(await q('SELECT count(*)::int n FROM appgastos.whatsapp_conversations'))[0].n;
   const r=await say('Compré en Carrefour',{from:'5491199999999'});
   assert.equal(r.outcome,'unauthorized');assert.equal(r.conversation_id,null);assert.equal(calls.length,callsBefore);
   assert.equal((await q('SELECT count(*)::int n FROM appgastos.whatsapp_conversations'))[0].n,conversations);
   const pending=await say('Compré en Carrefour');
   await q('UPDATE appgastos.family_members SET active=false WHERE id=$1',[ana]);
   try{
    assert.equal((await say('35 mil')).outcome,'unauthorized');
    assert.equal((await conversation(pending.conversation_id)).status,'error');
   }finally{await q('UPDATE appgastos.family_members SET active=true WHERE id=$1',[ana]);}
  });

  await t.test('30. confirmación en pesos y en US$',async()=>{
   script.set('Gasté 100 dólares en Amazon con Visa',{amount:'100',amountText:'100',currency:'USD',currencyText:'dólares',merchant:'Amazon',description:'Compra en Amazon',category:'Tecnología & Equipamiento',card:'Visa'});
   const r=await say('Gasté 100 dólares en Amazon con Visa');
   assert.equal(r.outcome,'registered');assert.equal(lastReply(),'✅ Registrado: US$ 100 en Amazon · Tecnología & Equipamiento · Visa.');
   assert.equal((await expense(r.expense_id)).currency,'USD');
  });

  // Corrección de un gasto YA registrado (caso real: "efectivo" y después "perdón, fue con tarjeta").
  const isolate=()=>{clock+=2*3600000;};
  const amountOf=async(id:string)=>(await expense(id)).amount_text;
  await t.test('corrección después de registrar: tarjeta genérica pregunta medio y tarjeta; edita el mismo gasto',async()=>{
   isolate();
   script.set('Compré en el carrefour',carrefour);
   await say('Compré en el carrefour');await say('40');
   const registered=await say('efectivo');
   assert.equal(registered.outcome,'registered');
   const before=await expenses();
   const fix=await say('perdón fue con tarjeta');
   assert.equal(fix.outcome,'corrected');assert.equal(fix.expense_id,null);
   assert.equal(lastReply(),'Corregido. ¿Cómo pagaste? Efectivo, débito, crédito, transferencia o billetera virtual.');
   assert.equal((await active()).draft.editingExpenseId,registered.expense_id);
   await say('débito');
   assert.equal(lastReply(),'¿Con qué tarjeta? 1) Mastercard Santander  2) Ninguna');
   const done=await say('1');
   assert.equal(done.outcome,'corrected');assert.equal(done.expense_id,null);
   assert.equal(lastReply(),'✏️ Corregido: $40 en Carrefour · Supermercado · Mastercard Santander.');
   assert.equal(await expenses(),before,'no se crea otro gasto');
   const e=await expense(registered.expense_id);
   assert.equal(e.payment_method,'debit_card');assert.equal(e.card_id,mcSantander);assert.equal(e.amount_text,'40.00');assert.equal(e.merchant,'Carrefour');
   const c=await conversation(done.conversation_id);assert.equal(c.status,'confirmed');assert.equal(c.expense_id,registered.expense_id);
   assert.equal(await active(),undefined);
  });

  await t.test('corrección inmediata de monto y comercio sobre el último gasto',async()=>{
   isolate();
   script.set('Perdón, fueron 45 mil',{amount:'45000',amountText:'45 mil'});
   script.set('me equivoqué, fue en Disco',{merchant:'Disco'});
   const registered=await say('Gasté 35 mil en Carrefour con Visa');
   const before=await expenses();
   const fix=await say('Perdón, fueron 45 mil');
   assert.equal(fix.outcome,'corrected');assert.equal(lastReply(),'✏️ Corregido: $45.000 en Carrefour · Supermercado · Visa.');
   assert.equal(await amountOf(registered.expense_id),'45000.00');
   assert.equal((await conversation(fix.conversation_id)).status,'confirmed');
   const moved=await say('me equivoqué, fue en Disco');
   assert.equal(moved.outcome,'corrected');
   const e=await expense(registered.expense_id);assert.equal(e.merchant,'Disco');assert.equal(e.amount_text,'45000.00');assert.equal(e.description,'Compra en Disco');
   assert.equal(await expenses(),before);
  });

  await t.test('solo el último gasto del mismo integrante, dentro de la ventana',async()=>{
   isolate();
   const older=await say('Gasté 35 mil en Carrefour con Visa');
   const latest=await say('Gasté 35 mil en Carrefour con Visa');
   await say('Perdón, fueron 45 mil');
   assert.equal(await amountOf(older.expense_id),'35000.00');assert.equal(await amountOf(latest.expense_id),'45000.00');
   // Pasada la ventana (30 min) la corrección es una interacción nueva y no toca el gasto.
   const late=await say('Perdón, fueron 45 mil',{at:clock+31*60000});
   assert.notEqual(late.outcome,'corrected');assert.equal(calls.at(-1)!.conversation,undefined);
   await say('cancelar');
   // El gasto de otro integrante nunca se corrige.
   isolate();
   const beto=await say('Gasté 35 mil en Carrefour con Visa',{from:BETO});
   const ana=await say('Perdón, fueron 45 mil');
   assert.notEqual(ana.outcome,'corrected');assert.equal(await amountOf(beto.expense_id),'35000.00');
   await say('cancelar');await q("UPDATE appgastos.whatsapp_conversations SET status='cancelled',closed_at=now() WHERE status='active'");
  });

  await t.test('sin frase de corrección es un gasto nuevo; gasto borrado no se corrige; cancelar la corrección',async()=>{
   isolate();
   const registered=await say('Gasté 35 mil en Carrefour con Visa');
   const fresh=await say('Compré en Carrefour');
   assert.equal(fresh.outcome,'question');assert.equal((await active()).draft.editingExpenseId,undefined);
   await say('cancelar');assert.equal(await amountOf(registered.expense_id),'35000.00');
   isolate();
   script.set('Gasté 35 mil en Carrefour en efectivo',{...carrefour,amount:'35000',amountText:'35 mil',paymentMethod:'cash',paymentMethodText:'efectivo'});
   const pending=await say('Gasté 35 mil en Carrefour en efectivo');
   await say('perdón fue con tarjeta');
   const cancelled=await say('cancelar');
   assert.equal(cancelled.outcome,'cancelled');assert.equal(lastReply(),'Listo, cancelé la corrección. El gasto quedó como estaba.');
   const e=await expense(pending.expense_id);assert.equal(e.payment_method,'cash');assert.equal(e.card_id,null);
   // "fue con tarjeta" sobre un gasto que ya era con tarjeta no cambia nada: pide el dato concreto.
   isolate();
   await say('Gasté 35 mil en Carrefour con Visa');
   const unclear=await say('perdón fue con tarjeta');
   assert.equal(unclear.outcome,'unrecognized');assert.match(lastReply(),/^No entendí qué corregir del último gasto \(\$35\.000 en Carrefour\)/);
   isolate();
   const removed=await say('Gasté 35 mil en Carrefour con Visa');
   await q('DELETE FROM appgastos.expenses WHERE id=$1',[removed.expense_id]);
   const count=await expenses();
   const after=await say('Perdón, fueron 45 mil');
   assert.notEqual(after.outcome,'corrected');assert.equal(await expenses(),count);
   await say('cancelar');
  });

  await t.test('conversaciones de integrantes distintos son independientes',async()=>{
   await say('Compré en Carrefour',{from:BETO});
   const r=await say('Gasté 35 mil en Carrefour con Visa');
   assert.equal(r.outcome,'registered');
   const beto=(await q("SELECT c.* FROM appgastos.whatsapp_conversations c JOIN appgastos.family_members m ON m.id=c.member_id WHERE m.name='Beto' AND c.status='active'"))[0];
   assert.ok(beto);assert.equal(beto.expected_field,'amount');
  });
 }finally{await db.stop();}
});
