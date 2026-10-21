// Límites configurables del procesamiento de comprobantes. Se leen en cada uso (no al importar) para que los tests y el
// operador puedan cambiarlos sin reiniciar módulos. Un valor inválido o fuera de rango cae al valor por defecto.
const int=(name:string,fallback:number,min:number,max:number)=>{
 const value=Number(process.env[name]);
 return process.env[name]&&Number.isInteger(value)&&value>=min&&value<=max?value:fallback;
};
export const documentLimits=()=>({
 // Meta admite hasta 5 MB por imagen. Gemini admite 20 MB por pedido inline: 14 MB de archivo ≈ 19 MB en base64.
 maxImageBytes:int('DOCUMENT_MAX_IMAGE_BYTES',5*1024*1024,1024,5*1024*1024),
 maxPdfBytes:int('DOCUMENT_MAX_PDF_BYTES',10*1024*1024,1024,14*1024*1024),
 maxPdfPages:int('DOCUMENT_MAX_PDF_PAGES',10,1,100),
 maxItems:int('DOCUMENT_MAX_ITEMS',80,1,300),
 maxLines:int('DOCUMENT_MAX_LINES',200,1,500),
 geminiTimeoutMs:int('DOCUMENT_TIMEOUT_MS',60000,5000,300000),
 maxAttempts:int('DOCUMENT_MAX_ATTEMPTS',3,1,10),
 // Tope por integrante y hora: acota el gasto en Gemini ante un envío masivo o un bucle.
 perHour:int('DOCUMENT_MAX_PER_HOUR',20,1,500),
 ttlHours:int('DOCUMENT_DRAFT_TTL_HOURS',168,1,24*60),
});
