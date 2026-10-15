
export type ReplySender=(to:string,text:string)=>Promise<void>;
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
  const response=await fetch('https://graph.facebook.com/'+version+'/'+id+'/messages',{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:JSON.stringify({messaging_product:'whatsapp',to:recipientNumber(to),type:'text',text:{body:text}}),
   signal:AbortSignal.timeout(15000),
  });
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
