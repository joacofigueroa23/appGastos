
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
  if(!response.ok)throw new Error('meta_send_failed');
  const body=await response.json() as {messages?:{id?:string}[]};
  if(!body.messages?.[0]?.id)throw new Error('meta_send_failed');
 };
}
