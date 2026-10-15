// Única lectura de la política de expiración de conversaciones de WhatsApp.
// WHATSAPP_CONVERSATION_TTL_MINUTES: entero 1..1440; ausente o inválido → 30 minutos.
export const DEFAULT_CONVERSATION_TTL_MINUTES=30;
let warned=false;
export function conversationTtlMinutes():number{
 const raw=process.env.WHATSAPP_CONVERSATION_TTL_MINUTES;
 if(raw===undefined||raw.trim()==='')return DEFAULT_CONVERSATION_TTL_MINUTES;
 const n=Number(raw);
 if(Number.isInteger(n)&&n>=1&&n<=1440)return n;
 if(!warned){warned=true;console.warn('whatsapp: conversation_ttl_invalid — se usan '+DEFAULT_CONVERSATION_TTL_MINUTES+' minutos');}
 return DEFAULT_CONVERSATION_TTL_MINUTES;
}
// Respuestas incomprensibles consecutivas antes de cancelar la conversación.
export const MAX_UNKNOWN_ANSWERS=3;
