import {inflateRawSync} from 'node:zlib';
import {documentLimits} from './limits';
import {DocumentError} from './validate';
// Planillas subidas desde la web (CSV o Excel .xlsx): se convierten a texto plano para que el modelo las lea como cualquier otro comprobante.
// Sin dependencias: un .xlsx es un ZIP con XML. Solo se lee la primera hoja, valores (sin fórmulas ni macros) y con topes de tamaño.
export const XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_CELL=200,MAX_TEXT=400_000,MAX_XML=30_000_000;
const clean=(s:string)=>s.replace(/[\u0000-\u0008\u000b-\u001f\u007f|]/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_CELL);

// ---- ZIP mínimo (solo lectura, solo método "deflate" o "stored", sin cifrado ni zip64).
function readZip(buf:Buffer):Map<string,Buffer>{
 const end=buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]),buf.length-22);
 if(end<0)throw new DocumentError('unreadable_sheet');
 const count=buf.readUInt16LE(end+10);let p=buf.readUInt32LE(end+16);
 const out=new Map<string,Buffer>();let budget=MAX_XML;
 for(let i=0;i<count;i++){
  if(p+46>buf.length||buf.readUInt32LE(p)!==0x02014b50)throw new DocumentError('unreadable_sheet');
  const flags=buf.readUInt16LE(p+8),method=buf.readUInt16LE(p+10),size=buf.readUInt32LE(p+20),name=buf.toString('utf8',p+46,p+46+buf.readUInt16LE(p+28)),local=buf.readUInt32LE(p+42);
  p+=46+buf.readUInt16LE(p+28)+buf.readUInt16LE(p+30)+buf.readUInt16LE(p+32);
  if(!/^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|styles\.xml)$/.test(name))continue;
  if(flags&1||(method!==0&&method!==8)||local+30>buf.length)throw new DocumentError('unreadable_sheet');
  const start=local+30+buf.readUInt16LE(local+26)+buf.readUInt16LE(local+28);
  if(start+size>buf.length)throw new DocumentError('unreadable_sheet');
  const raw=buf.subarray(start,start+size);
  try{
   const data=method===0?raw:inflateRawSync(raw,{maxOutputLength:budget});
   budget-=data.length;out.set(name,data);
  }catch{throw new DocumentError('unreadable_sheet');}
 }
 return out;
}
const entities=(s:string)=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,e:string)=>{
 const l=e.toLowerCase();
 if(l==='amp')return '&';if(l==='lt')return '<';if(l==='gt')return '>';if(l==='quot')return '"';if(l==='apos')return "'";
 const code=l[1]==='x'?parseInt(l.slice(2),16):parseInt(l.slice(1),10);
 return code>0&&code<0x110000?String.fromCodePoint(code):' ';
});
const texts=(xml:string)=>entities([...xml.replace(/<rPh[\s\S]*?<\/rPh>/g,'').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>m[1]).join(''));
const column=(ref:string)=>[...ref.replace(/[0-9]/g,'')].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
// Estilos que representan fechas: formatos incorporados de fecha/hora y formatos propios con d, m o y fuera de comillas y corchetes.
const BUILTIN_DATES=new Set([14,15,16,17,18,19,20,21,22,27,28,29,30,31,32,33,34,35,36,45,46,47,50,51,52,53,54,55,56,57,58]);
function dateStyles(xml:string):Set<number>{
 const custom=new Map<number,boolean>();
 for(const m of xml.matchAll(/<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))custom.set(Number(m[1]),/[dmy]/i.test(entities(m[2]).replace(/"[^"]*"|\[[^\]]*\]|\\./g,'')));
 const xfs=/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1]||'';
 const out=new Set<number>();
 [...xfs.matchAll(/<xf\s[^>]*?numFmtId="(\d+)"/g)].forEach((m,i)=>{const id=Number(m[1]);if(BUILTIN_DATES.has(id)||custom.get(id))out.add(i);});
 return out;
}
const isoFromSerial=(serial:number)=>new Date(Date.UTC(1899,11,30)+Math.floor(serial)*86400000).toISOString().slice(0,10);
function xlsxRows(bytes:Buffer):string[][]{
 const files=readZip(bytes);
 const sheetName=[...files.keys()].filter(k=>k.startsWith('xl/worksheets/')).sort((a,b)=>Number(a.replace(/\D/g,''))-Number(b.replace(/\D/g,'')))[0];
 if(!sheetName)throw new DocumentError('unreadable_sheet');
 const shared=[...(files.get('xl/sharedStrings.xml')?.toString('utf8')||'').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m=>texts(m[1]));
 const dates=dateStyles(files.get('xl/styles.xml')?.toString('utf8')||'');
 const rows:string[][]=[];
 for(const r of files.get(sheetName)!.toString('utf8').matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)){
  const cells:string[]=[];
  for(const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
   const attrs=c[1],ref=/\br="([A-Z]+)\d+"/.exec(attrs)?.[1],type=/\bt="(\w+)"/.exec(attrs)?.[1],style=Number(/\bs="(\d+)"/.exec(attrs)?.[1]??-1),body=c[2]||'';
   if(!ref)continue;
   const v=/<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
   let value='';
   if(type==='s')value=shared[Number(v)]??'';
   else if(type==='inlineStr')value=texts(body);
   else if(type==='b')value=v==='1'?'sí':'no';
   else if(v!==undefined)value=type==='str'||type==='e'?entities(v):dates.has(style)&&Number.isFinite(Number(v))?isoFromSerial(Number(v)):v;
   const col=column(ref);
   if(col>=0&&col<60)cells[col]=clean(value);
  }
  rows.push(Array.from(cells,x=>x??''));
 }
 return rows;
}

// ---- CSV: separador detectado (coma, punto y coma o tabulación) y comillas con "" escapadas.
function csvRows(bytes:Buffer):string[][]{
 const text=bytes.toString('utf8').replace(/^﻿/,'');
 const head=text.slice(0,2000).split('\n')[0]||'';
 const sep=[';','\t',','].map(s=>[s,head.split(s).length]).sort((a,b)=>(b[1] as number)-(a[1] as number))[0][0] as string;
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 const endRow=()=>{row.push(cell);cell='';rows.push(row.map(clean));row=[];};
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=ch;}
  else if(ch==='"'&&!cell)quoted=true;
  else if(ch===sep){row.push(cell);cell='';}
  else if(ch==='\n'){endRow();}
  else if(ch!=='\r')cell+=ch;
  if(rows.length>5000)throw new DocumentError('too_many_rows');
 }
 if(cell||row.length)endRow();
 return rows;
}
export const isSheetName=(name:string)=>/\.(csv|xlsx)$/i.test(name);
// Devuelve el texto que se le manda al modelo (una fila por línea, celdas separadas por " | ") y la cantidad de filas con datos.
export function sheetToText(bytes:Buffer,filename:string):{text:string;rows:number}{
 if(!bytes.length)throw new DocumentError('empty_file');
 if(bytes.length>5*1024*1024)throw new DocumentError('too_large');
 const xlsx=/\.xlsx$/i.test(filename);
 if(xlsx&&!(bytes[0]===0x50&&bytes[1]===0x4b))throw new DocumentError('type_mismatch');
 if(!xlsx&&bytes[0]===0x50&&bytes[1]===0x4b)throw new DocumentError('type_mismatch');
 const rows=(xlsx?xlsxRows(bytes):csvRows(bytes)).filter(r=>r.some(c=>c));
 if(rows.length<2)throw new DocumentError('empty_file');
 if(rows.length-1>documentLimits().maxLines)throw new DocumentError('too_many_rows');
 const text=rows.map(r=>r.join(' | ')).join('\n');
 if(text.length>MAX_TEXT)throw new DocumentError('too_large');
 return {text,rows:rows.length-1};
}
