// Rastro estructurado de las decisiones del bot para diagnosticar en los logs del servidor. NUNCA lleva contenido: ni texto del usuario, ni importes,
// ni comercios, ni datos del comprobante; solo qué camino se tomó y códigos cortos. BOT_TRACE=off lo apaga.
export function trace(event:string,fields:Record<string,string|number|boolean|null|string[]>={}):void{
 if(process.env.BOT_TRACE==='off'||process.env.NODE_TEST_CONTEXT)return;
 console.info(JSON.stringify({ev:event,at:new Date().toISOString(),...fields}));
}
