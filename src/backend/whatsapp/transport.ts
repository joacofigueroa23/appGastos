
export type ReplySender=(to:string,text:string)=>Promise<void>;
// Botones de respuesta de WhatsApp (interactive/button: hasta 3, título de hasta 20 caracteres, cuerpo de hasta 1024). Se derivan del propio texto de la
// respuesta: el texto siempre viaja completo (es la alternativa si el cliente no muestra botones) y el botón solo repite una opción que ya está escrita.
// El id del botón nunca es una orden: al volver se traduce a un comando de texto que pasa por las mismas validaciones (dueño, estado, código).
export interface ReplyButton {id:string;title:string}
export function buttonsFor(text:string):ReplyButton[]|null{
 if(text.length>1024)return null;
 const options=/— respondé el número/.test(text)?[...text.matchAll(/(?:^|\s)([1-3])\) ([^\n]+?)(?=\s{2}[1-3]\)| — respondé)/g)]:[];
 if(options.length)return options.map(o=>({id:'s:'+o[1],title:o[2].trim().slice(0,20)}));
 const code=/Todavía no registré nada\.[^\n]*\nCódigo: ([A-Z0-9]{4})\s*$/.exec(text)?.[1];
 if(code&&!/(?:^|\n)¿/.test(text))return [{id:'c:'+code,title:'Confirmar'},{id:'x:'+code,title:'Cancelar'}];
 if(text.includes('respondé *deshacer*'))return [{id:'u',title:'Deshacer'}];
 return null;
}
// Toque de un botón (webhook interactive/button_reply) → el texto equivalente. Un id desconocido o malformado no es nada.
export function tappedButtonText(interactive:unknown):string|null{
 const id=(interactive as {type?:unknown;button_reply?:{id?:unknown}}|null)?.type==='button_reply'?(interactive as {button_reply?:{id?:unknown}}).button_reply?.id:null;
 if(typeof id!=='string')return null;
 let m:RegExpExecArray|null;
 if((m=/^c:([A-Z0-9]{4})$/.exec(id)))return 'confirmar '+m[1];
 if((m=/^x:([A-Z0-9]{4})$/.exec(id)))return 'cancelar '+m[1];
 if((m=/^s:([1-3])$/.exec(id)))return m[1];
 return id==='u'?'deshacer':null;
}
// Meta entrega celulares argentinos como 549…, pero rechaza enviar a ese formato (131030);
// sin el 9 lo acepta y lo resuelve al mismo wa_id. La identidad del remitente no cambia.
export function recipientNumber(waId:string):string{
 return /^549\d{10}$/.test(waId)?'54'+waId.slice(3):waId;
}
export function metaSender():ReplySender{
 return async(to,text)=>{
  const token=process.env.WHATSAPP_ACCESS_TOKEN,id=process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!token||!id||!/^\d+$/.test(id))throw new Error('meta_not_configured');
  const version=process.env.WHATSAPP_GRAPH_VERSION||'v21.0';
  if(!/^v\d+\.0$/.test(version))throw new Error('meta_version_invalid');
  const post=(message:Record<string,unknown>)=>fetch('https://graph.facebook.com/'+version+'/'+id+'/messages',{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify({messaging_product:'whatsapp',to:recipientNumber(to),...message}),
   signal:AbortSignal.timeout(15000),
  });
  const plain={type:'text',text:{body:text}},buttons=buttonsFor(text);
  let response=await post(buttons?{type:'interactive',interactive:{type:'button',body:{text},action:{buttons:buttons.map(b=>({type:'reply',reply:b}))}}}:plain);
  // Si Meta rechaza el mensaje con botones, el mismo texto sale sin ellos: el usuario nunca se queda sin respuesta.
  if(!response.ok&&buttons&&response.status!==401)response=await post(plain);
  if(!response.ok){
   // 190 = token vencido o revocado: requiere un token nuevo, reintentar no alcanza.
   const code=(await response.json().catch(()=>null) as {error?:{code?:number}}|null)?.error?.code;
   throw new Error(code===190?'meta_token_expired':'meta_send_failed');
  }
  const body=await response.json() as {messages?:{id?:string}[]};
  if(!body.messages?.[0]?.id)throw new Error('meta_send_failed');
 };
}
const DAY=86400000;
// Estado del token sin exponerlo: 'never' (System User permanente), 'expired', 'expires_soon' o 'ok'.
export async function metaTokenStatus(now=Date.now(),fetcher:typeof fetch=fetch):Promise<'never'|'ok'|'expires_soon'|'expired'|'unknown'>{
 const token=process.env.WHATSAPP_ACCESS_TOKEN;if(!token)return 'unknown';
 const version=process.env.WHATSAPP_GRAPH_VERSION||'v21.0';
 try{
  const url='https://graph.facebook.com/'+version+'/debug_token?input_token='+encodeURIComponent(token)+'&access_token='+encodeURIComponent(token);
  const body=await (await fetcher(url,{signal:AbortSignal.timeout(10000)})).json() as {data?:{is_valid?:boolean;expires_at?:number};error?:{code?:number}};
  if(body.error?.code===190||body.data?.is_valid===false)return 'expired';
  const expires=body.data?.expires_at;
  if(expires===0)return 'never';
  if(typeof expires!=='number')return 'unknown';
  return expires*1000<=now?'expired':expires*1000-now<7*DAY?'expires_soon':'ok';
 }catch{return 'unknown';}
}
