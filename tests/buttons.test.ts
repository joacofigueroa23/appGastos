import test from 'node:test';
import assert from 'node:assert/strict';
import {buttonsFor,tappedButtonText} from '../src/backend/whatsapp/transport';

test('botones derivados del texto: opciones numeradas, confirmar/cancelar y deshacer; el texto siempre queda completo',()=>{
 const ask='💸 Comprobante de pago de Brenda · 27/10/2026\nTotal $11.600 · gasto personal\n1) Brenda — $11.600\n¿En qué categoría va este pago? 1) Supermercado  2) Comida  3) Ocio y entretenimiento largo — respondé el número, o decime otra.\nTodavía no registré nada. Respondé *confirmar*.\nCódigo: AB12';
 assert.deepEqual(buttonsFor(ask),[{id:'s:1',title:'Supermercado'},{id:'s:2',title:'Comida'},{id:'s:3',title:'Ocio y entretenimien'}]);
 const ready='🧾 Ticket de YPF · 26/10/2026\nTotal $20.000 · gasto personal\nCategoría: Combustible\n1) Nafta — $20.000\nTodavía no registré nada. Respondé *confirmar* para registrarlo o *cancelar* para descartarlo.\nCódigo: ZZ99';
 assert.deepEqual(buttonsFor(ready),[{id:'c:ZZ99',title:'Confirmar'},{id:'x:ZZ99',title:'Cancelar'}]);
 assert.equal(buttonsFor(ready.replace('Categoría: Combustible','¿En qué categoría va este ticket? Tus categorías: A, B.')),null,'con una pregunta pendiente no hay botón de confirmar');
 assert.deepEqual(buttonsFor('✅ Registrado.\nSi está mal, respondé *deshacer* y lo borro.'),[{id:'u',title:'Deshacer'}]);
 assert.equal(buttonsFor('hola'),null);assert.equal(buttonsFor('x'.repeat(1100)),null,'más de 1024 caracteres: solo texto');
});

test('toque de botón: solo ids conocidos y bien formados se traducen a un comando de texto',()=>{
 const tap=(id:unknown)=>tappedButtonText({type:'button_reply',button_reply:{id,title:'x'}});
 assert.equal(tap('c:AB12'),'confirmar AB12');assert.equal(tap('x:AB12'),'cancelar AB12');assert.equal(tap('s:2'),'2');assert.equal(tap('u'),'deshacer');
 for(const bad of ['c:ab12','c:AB1','s:4','confirmar','c:AB12; DROP',42,null])assert.equal(tap(bad),null,String(bad));
 assert.equal(tappedButtonText({type:'list_reply',list_reply:{id:'u'}}),null);assert.equal(tappedButtonText(undefined),null);
});
