
import type {Pool} from 'pg';
import type {ApiCard,ApiMember} from '../../shared/apiTypes';
import type {ReferenceChanges,ReferenceKind} from './validation';
// Columna propia de cada tipo de referencia: teléfono del integrante o tipo de la tarjeta.
const extra={family_members:['phoneNumber','phone_number'],cards:['cardType','card_type']} as const;
function columns(kind:ReferenceKind){
 return 'id,family_id AS "familyId",name,active,created_at AS "createdAt",'+extra[kind][1]+' AS "'+extra[kind][0]+'"';
}
function dto(row:any):ApiCard|ApiMember{return {...row,createdAt:row.createdAt.toISOString()};}
export async function listReferences(pool:Pool,family:string,kind:ReferenceKind){
 const r=await pool.query('SELECT '+columns(kind)+' FROM appgastos.'+kind+' WHERE family_id=$1 ORDER BY name,id',[family]);
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
