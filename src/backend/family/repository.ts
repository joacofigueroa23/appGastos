
import type {Pool} from 'pg';
import type {ApiCard,ApiMember} from '../../shared/apiTypes';
import type {ReferenceChanges,ReferenceKind} from './validation';
// Columna propia de cada tipo de referencia: teléfono del integrante o tipo de la tarjeta.
const extra={family_members:['phoneNumber','phone_number'],cards:['cardType','card_type']} as const;
function columns(kind:ReferenceKind){
 return 'id,family_id AS "familyId",name,active,created_at AS "createdAt",'+extra[kind][1]+' AS "'+extra[kind][0]+'"'+(kind==='family_members'?',(auth_user_id IS NOT NULL) AS linked,role':'');
}
function dto(row:any):ApiCard|ApiMember{return {...row,createdAt:row.createdAt.toISOString()};}
// only: limita a una fila (el integrante que consulta)
export async function listReferences(pool:Pool,family:string,kind:ReferenceKind,only?:string){
 const r=await pool.query('SELECT '+columns(kind)+' FROM appgastos.'+kind+' WHERE family_id=$1'+(only?' AND id=$2':'')+' ORDER BY name,id',only?[family,only]:[family]);
 return r.rows.map(dto);
}
export async function insertReference(pool:Pool,family:string,kind:ReferenceKind,input:ReferenceChanges){
 const [field,column]=extra[kind];
 const r=await pool.query('INSERT INTO appgastos.'+kind+' (family_id,name,active,'+column+') VALUES($1,$2,$3,$4) RETURNING '+columns(kind),
  [family,input.name,input.active,input[field]]);
 return dto(r.rows[0]);
}
export async function updateReference(pool:Pool,family:string,kind:ReferenceKind,id:string,input:ReferenceChanges){
 const args:unknown[]=[family,id],sets:string[]=[];
 for(const [field,column] of [['name','name'],['active','active'],extra[kind]] as const){
  if(Object.hasOwn(input,field)){args.push(input[field]);sets.push(column+'=$'+args.length);}
 }
 const r=await pool.query('UPDATE appgastos.'+kind+' SET '+sets.join(',')+' WHERE family_id=$1 AND id=$2 RETURNING '+columns(kind),args);
 return r.rows[0]?dto(r.rows[0]):null;
}
// Datos que el bot de WhatsApp le da a Gemini: moneda de la familia, categorías y tarjetas.
export async function catalogRows(pool:Pool,family:string){
 const familyRow=(await pool.query('SELECT default_currency FROM appgastos.families WHERE id=$1',[family])).rows[0];
 const categories=(await pool.query('SELECT id,name,active FROM appgastos.categories WHERE family_id=$1',[family])).rows;
 const cards=(await pool.query('SELECT id,name,active,card_type AS "cardType" FROM appgastos.cards WHERE family_id=$1',[family])).rows;
 return {defaultCurrency:familyRow.default_currency as string,categories,cards};
}
export async function memberPhones(pool:Pool,family:string){
 return (await pool.query('SELECT id,name,active,phone_number,role FROM appgastos.family_members WHERE family_id=$1',[family])).rows;
}
