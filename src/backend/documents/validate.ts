import {documentLimits} from './limits';
// code: causa técnica segura (nunca texto del documento). transient: vale la pena reintentar.
export class DocumentError extends Error {constructor(public code:string,public transient=false){super(code);}}
export type MediaMime='image/jpeg'|'image/png'|'application/pdf';
const ALLOWED:readonly string[]=['image/jpeg','image/png','application/pdf'];
export const REJECTED_TYPE_REPLY='Solo puedo leer fotos (JPG o PNG) y archivos PDF.';
// El tipo que declara Meta ("image/jpeg; charset=…" incluido) debe ser uno admitido.
export const declaredMime=(value:unknown):MediaMime|null=>{
 const mime=typeof value==='string'?value.split(';')[0].trim().toLowerCase():'';
 return ALLOWED.includes(mime)?mime as MediaMime:null;
};
// Tipo REAL por los primeros bytes: el tipo declarado no alcanza como prueba.
export function detectType(bytes:Buffer):MediaMime|null{
 if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
 if(bytes.subarray(0,1024).includes('%PDF-'))return 'application/pdf';
 return null;
}
// shortcut: cuenta marcas "/Type /Page" en el texto del PDF; los PDF con objetos comprimidos pueden dar 0 (se asume 1 página y
// vale solo el tope de tamaño). Cambiar a un lector de PDF si hace falta un tope exacto de páginas.
export const countPdfPages=(bytes:Buffer)=>(bytes.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g)||[]).length;
export function validateMedia(bytes:Buffer,declared:unknown):{mime:MediaMime;pages:number}{
 const limits=documentLimits();
 if(!bytes.length)throw new DocumentError('empty_file');
 const wanted=declaredMime(declared);
 if(!wanted)throw new DocumentError('unsupported_type');
 const real=detectType(bytes);
 if(!real)throw new DocumentError('unsupported_type');
 if(real!==wanted)throw new DocumentError('type_mismatch');
 if(bytes.length>(real==='application/pdf'?limits.maxPdfBytes:limits.maxImageBytes))throw new DocumentError('too_large');
 const pages=real==='application/pdf'?Math.max(1,countPdfPages(bytes)):1;
 if(pages>limits.maxPdfPages)throw new DocumentError('too_many_pages');
 return {mime:real,pages};
}
// Texto para el usuario según la causa; nunca incluye contenido del documento.
export const failureReply=(code:string):string=>({
 unsupported_type:REJECTED_TYPE_REPLY,type_mismatch:'El archivo no es del tipo que dice ser. '+REJECTED_TYPE_REPLY,
 too_large:'El archivo es demasiado grande. Mandalo más liviano (fotos hasta 5 MB, PDF hasta 10 MB).',
 too_many_pages:'El PDF tiene demasiadas páginas. Mandá solo las que necesitás.',
 empty_file:'El archivo llegó vacío. Probá de nuevo.',media_gone:'Ese archivo ya no está disponible en WhatsApp. Mandalo de nuevo.',
 too_many_rows:'La planilla tiene demasiadas filas. Dividila en partes más chicas (hasta 200 movimientos).',unreadable_sheet:'No pude abrir la planilla. Guardala como .xlsx o .csv e intentá de nuevo.',
 unreadable:'No pude leer el comprobante. Probá con una foto más nítida, de frente y con buena luz.',
}[code]||'No pude procesar el comprobante. Probá de nuevo en unos minutos o cargá el gasto a mano.');
