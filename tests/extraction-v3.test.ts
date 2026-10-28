import test from 'node:test';
import assert from 'node:assert/strict';
import {geminiDocumentExtractor,parseExtraction,parseLocalAmount,parseLocalDate,readingProblems,type DocGenerate} from '../src/backend/documents/extraction';
import {buildReceiptDraft,canAutoRegister,applyEdit,type DraftContext} from '../src/backend/documents/draft';

const ctx:DraftContext={categories:[{id:'c-sup',name:'Supermercado',active:true}],cards:[],familyCurrency:'ARS',today:'2026-10-27'};
const input={bytes:Buffer.from([0xff,0xd8,0xff]),mime:'image/jpeg' as const,categories:['Supermercado'],today:'2026-10-27',familyCurrency:'ARS'};
const transfer=(o:Record<string,unknown>={})=>({documentType:'payment_receipt',merchant:'Mercado Pago',provider:'Mercado Pago',recipient:'Brenda',documentDate:'2026-10-27',time:'18:19',totalAmount:'11600.00',currency:'ARS',
 paymentStatus:'paid',paymentMethod:null,paymentReference:'123456',evidence:{total:'$ 11.600,00',date:'27/10/2026'},items:[],warnings:[],missingFields:[],...o});
const fake=(...answers:Record<string,unknown>[]):{generate:DocGenerate;calls:number}=>{
 const state={calls:0,generate:(async()=>({text:JSON.stringify(answers[Math.min(state.calls++,answers.length-1)]),usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,totalTokenCount:110}})) as DocGenerate};
 return state;
};

test('importes y fechas impresos en formato argentino',()=>{
 for(const [raw,out] of [['$ 11.600,00','11600.00'],['11.600','11600.00'],['1.234,5','1234.50'],['11,600.00','11600.00'],['11600','11600.00'],['35.689,20','35689.20'],['0,32','0.32']])assert.equal(parseLocalAmount(raw),out,raw);
 assert.equal(parseLocalAmount('abc'),null);assert.equal(parseLocalAmount('1,23456'),null);
 assert.equal(parseLocalDate('27/10/2026'),'2026-10-27');assert.equal(parseLocalDate('27-10-26'),'2026-10-27');assert.equal(parseLocalDate('27 de octubre de 2026'),'2026-10-27');assert.equal(parseLocalDate('31/02/2026'),null);assert.equal(parseLocalDate('hoy'),null);
});

test('Mercado Pago es el proveedor, no el comercio: el vendedor es el destinatario y el medio de pago no se infiere del logo',()=>{
 const e=parseExtraction(transfer(),['Supermercado']);
 assert.equal(e.merchant,'Brenda');assert.equal(e.provider,'Mercado Pago');assert.equal(e.paymentMethod,null);
 const d=buildReceiptDraft(e,ctx,'payment_receipt',false);
 assert.match(d.description,/Pago a Brenda/);assert.equal(d.total,'11600.00');assert.equal(d.date,'2026-10-27');assert.equal(d.paymentMethod,null);
 // Solo se ve el proveedor: no se inventa un comercio.
 assert.equal(parseExtraction(transfer({recipient:null}),[]).merchant,null);
});

test('lectura consistente: una sola llamada, sin duda',async()=>{
 const f=fake(transfer());
 const r=await geminiDocumentExtractor(f.generate)(input);
 assert.equal(f.calls,1);assert.equal(r.usage.attempts,1);assert.ok(!r.extraction.warnings.includes('lectura_dudosa'));
});

test('el total no coincide con lo que el modelo dijo ver: segunda lectura y se usa la consistente',async()=>{
 const f=fake(transfer({totalAmount:'35689.20'}),transfer());
 const r=await geminiDocumentExtractor(f.generate)(input);
 assert.equal(f.calls,2);assert.equal(r.usage.attempts,2);assert.equal(r.extraction.totalAmount,'11600.00');assert.ok(!r.extraction.warnings.includes('lectura_dudosa'));
 assert.equal(r.usage.totalTokens,220,'se suma el costo de ambas lecturas');
});

test('si la segunda lectura sigue inconsistente: lectura dudosa, nunca se registra sola, y el usuario puede corregir',async()=>{
 const bad=transfer({totalAmount:'35689.20'});
 const f=fake(bad,bad);
 const r=await geminiDocumentExtractor(f.generate)(input);
 assert.equal(f.calls,2,'una sola segunda lectura, sin bucles');assert.ok(r.extraction.warnings.includes('lectura_dudosa'));
 process.env.DOCUMENT_AUTO_REGISTER='true';
 try{
  const full={...r.extraction,paymentMethod:'cash' as const,category:'Supermercado'};
  const d=buildReceiptDraft(full,ctx,'payment_receipt',false);
  assert.equal(d.doubt,true);assert.equal(canAutoRegister(d,ctx),false);
  assert.ok(d.notes.some(n=>/No estoy seguro de haber leído bien/.test(n)));
  const fixed=applyEdit(d,{type:'total',value:'11600.00'},ctx).draft as typeof d;
  assert.equal(fixed.doubt,undefined);assert.equal(canAutoRegister(fixed,ctx),true);
 }finally{delete process.env.DOCUMENT_AUTO_REGISTER;}
});

test('fecha implausible o del futuro dispara la segunda lectura; la segunda que falla conserva la primera como dudosa',async()=>{
 assert.deepEqual(readingProblems(parseExtraction(transfer({documentDate:'2027-03-01',evidence:null}),[]),'2026-10-27'),['fecha_implausible']);
 const calls={n:0};
 const f2:DocGenerate=async()=>{if(calls.n++%2===0)return {text:JSON.stringify(transfer({documentDate:'2026-10-26'}))};throw Object.assign(new Error('x'),{status:503});};
 const r=await geminiDocumentExtractor(f2)(input);
 assert.ok(r.extraction.warnings.includes('lectura_dudosa'));assert.equal(r.extraction.documentDate,'2026-10-26');
});

test('un comprobante sin total pide mejor foto pero no marca duda ni inventa importes',async()=>{
 const f=fake(transfer({totalAmount:null,evidence:null}));
 const r=await geminiDocumentExtractor(f.generate)(input);
 assert.equal(f.calls,2);assert.equal(r.extraction.totalAmount,null);assert.ok(!r.extraction.warnings.includes('lectura_dudosa'));
});
