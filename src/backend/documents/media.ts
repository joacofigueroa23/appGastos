import {DocumentError} from './validate';
export interface FetchedMedia {bytes:Buffer;mime:string}
// Descarga autenticada por la API oficial de Meta (documentación de "Media" de WhatsApp Cloud API):
//  1) GET graph.facebook.com/<versión>/<media-id> con el token → url, mime_type, file_size
//  2) GET <url> con el mismo token. La url vence a los 5 minutos: ante un 404 se pide una nueva en el reintento.
// Nunca se descarga una URL tomada del mensaje del usuario: solo la que devuelve Meta para ese id.
export type MediaFetcher=(mediaId:string,maxBytes:number)=>Promise<FetchedMedia>;
// El token solo viaja a hosts de Meta. https obligatorio, sin IP literal y sin seguir redirecciones.
const META_HOSTS=['fbsbx.com','facebook.com','fbcdn.net','whatsapp.net','whatsapp.com'];
export function trustedMediaUrl(value:unknown):URL|null{
 try{
  const url=new URL(String(value));
  if(url.protocol!=='https:'||url.username||url.password)return null;
  const host=url.hostname.toLowerCase();
  if(/^[\d.]+$/.test(host)||host.includes(':'))return null;
  return META_HOSTS.some(h=>host===h||host.endsWith('.'+h))?url:null;
 }catch{return null;}
}
const retryable=(status:number)=>status===408||status===429||status>=500;
export function metaMediaFetcher(fetcher:typeof fetch=fetch):MediaFetcher{
 return async(mediaId,maxBytes)=>{
  const token=process.env.WHATSAPP_ACCESS_TOKEN,version=process.env.WHATSAPP_GRAPH_VERSION||'v21.0';
  if(!token)throw new DocumentError('meta_not_configured');
  if(!/^v\d+\.0$/.test(version))throw new DocumentError('meta_version_invalid');
  if(!/^\d{1,40}$/.test(mediaId))throw new DocumentError('media_id_invalid');
  const headers={Authorization:'Bearer '+token};
  const call=async(url:string)=>{
   try{return await fetcher(url,{headers,signal:AbortSignal.timeout(20000),redirect:'error'});}
   catch{throw new DocumentError('media_network',true);}
  };
  const lookup=await call('https://graph.facebook.com/'+version+'/'+mediaId);
  if(lookup.status===404)throw new DocumentError('media_gone');
  if(lookup.status===401||lookup.status===403)throw new DocumentError('meta_token_expired');
  if(!lookup.ok)throw new DocumentError('media_lookup_failed',retryable(lookup.status));
  const info=await lookup.json().catch(()=>null) as {url?:string;mime_type?:string;file_size?:number}|null;
  const url=trustedMediaUrl(info?.url);
  if(!url)throw new DocumentError('media_url_rejected');
  if(typeof info?.file_size==='number'&&info.file_size>maxBytes)throw new DocumentError('too_large');
  const file=await call(url.toString());
  if(file.status===404)throw new DocumentError('media_url_expired',true);
  if(!file.ok||!file.body)throw new DocumentError('media_download_failed',retryable(file.status));
  // Se corta apenas se supera el tope: un archivo enorme no se carga entero en memoria.
  const chunks:Buffer[]=[];let total=0;
  const reader=file.body.getReader();
  try{
   for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    total+=value.length;
    if(total>maxBytes){await reader.cancel().catch(()=>{});throw new DocumentError('too_large');}
    chunks.push(Buffer.from(value));
   }
  }catch(error){
   if(error instanceof DocumentError)throw error;
   throw new DocumentError('media_network',true);
  }
  return {bytes:Buffer.concat(chunks),mime:String(info?.mime_type||file.headers.get('content-type')||'')};
 };
}
