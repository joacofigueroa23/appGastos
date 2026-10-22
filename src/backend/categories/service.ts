import type {Pool} from 'pg';
import {ApiError} from '../shared/errors';
import {object,text,uuid} from '../shared/validators';
import {normalizeName} from '../whatsapp/candidate';
import {inTransaction,type Connection} from '../expenses/repository';
import type {ApiCategory} from '../../shared/apiTypes';
// Categorías principales y subcategorías (máximo dos niveles). Solo administradores las modifican (las rutas lo exigen).
// Nunca se borran: se archivan (active=false) y conservan su id y sus movimientos. Cambiar o reorganizar una categoría no reclasifica
// ningún gasto: los gastos apuntan al id. Los nombres son únicos en toda la familia (restricción heredada de la base).
const COLUMNS='id,family_id AS "familyId",name,active,created_at AS "createdAt",parent_id AS "parentId"';
export const listCategoryRows=async(db:Connection,family:string):Promise<ApiCategory[]>=>(await db.query(`SELECT ${COLUMNS} FROM appgastos.categories WHERE family_id=$1 ORDER BY name,id`,[family])).rows;
export function categoryService(pool:Pool,family:string){
 const validate=(body:unknown,creating:boolean)=>{
  const input=object(body);
  if(!Object.keys(input).length||Object.keys(input).some(k=>!['name','parentId','active'].includes(k)))throw new ApiError(400,'Campos de categoría inválidos.');
  const out:{name?:string;parentId?:string|null;active?:boolean}={};
  if(creating||Object.hasOwn(input,'name'))out.name=text(input.name,'name',120);
  if(Object.hasOwn(input,'parentId'))out.parentId=input.parentId===null?null:uuid(input.parentId,'parentId');
  if(Object.hasOwn(input,'active')){if(typeof input.active!=='boolean')throw new ApiError(400,'active debe ser booleano.');out.active=input.active;}
  return out;
 };
 // Reglas de estructura con mensajes claros; la base también las garantiza (trigger) ante una carrera.
 async function checkStructure(db:Connection,id:string|null,parentId:string|null|undefined,name:string|undefined){
  if(name!==undefined){
   const same=(await db.query('SELECT id,name FROM appgastos.categories WHERE family_id=$1',[family])).rows.find((c:{id:string;name:string})=>c.id!==id&&normalizeName(c.name)===normalizeName(name));
   if(same)throw new ApiError(409,'Ya existe una categoría llamada «'+same.name+'».');
  }
  if(parentId){
   if(parentId===id)throw new ApiError(400,'Una categoría no puede ser su propia subcategoría.');
   const parent=(await db.query('SELECT parent_id FROM appgastos.categories WHERE family_id=$1 AND id=$2',[family,parentId])).rows[0];
   if(!parent)throw new ApiError(404,'La categoría principal no existe.');
   if(parent.parent_id)throw new ApiError(400,'Solo hay dos niveles: una subcategoría no puede tener subcategorías.');
   if(id&&(await db.query('SELECT 1 FROM appgastos.categories WHERE family_id=$1 AND parent_id=$2 LIMIT 1',[family,id])).rowCount)throw new ApiError(400,'Esta categoría ya tiene subcategorías: no puede pasar a ser subcategoría.');
  }
 }
 const guard=async<T>(work:()=>Promise<T>)=>{
  try{return await work();}
  catch(error){
   const e=error as {code?:string;message?:string};
   if(e.code==='23505')throw new ApiError(409,'Ya existe una categoría con ese nombre.');
   if(e.message==='category_depth')throw new ApiError(400,'Solo hay dos niveles de categorías.');
   throw error;
  }
 };
 return {
  list:()=>listCategoryRows(pool,family),
  create:(body:unknown)=>guard(()=>inTransaction(pool,async db=>{
   const v=validate(body,true);
   await checkStructure(db,null,v.parentId,v.name);
   const r=await db.query('INSERT INTO appgastos.categories(family_id,name,active,parent_id) VALUES($1,$2,$3,$4) RETURNING '+COLUMNS,[family,v.name,v.active??true,v.parentId??null]);
   return r.rows[0] as ApiCategory;
  })),
  update:(idValue:string,body:unknown)=>guard(()=>inTransaction(pool,async db=>{
   const id=uuid(idValue),v=validate(body,false);
   if(!(await db.query('SELECT 1 FROM appgastos.categories WHERE family_id=$1 AND id=$2 FOR UPDATE',[family,id])).rowCount)throw new ApiError(404,'Categoría inexistente.');
   await checkStructure(db,id,v.parentId,v.name);
   const args:unknown[]=[family,id],sets:string[]=[];
   for(const [key,column] of [['name','name'],['parentId','parent_id'],['active','active']] as const)if(Object.hasOwn(v,key)){args.push(v[key]);sets.push(column+'=$'+args.length);}
   return (await db.query(`UPDATE appgastos.categories SET ${sets.join(',')} WHERE family_id=$1 AND id=$2 RETURNING ${COLUMNS}`,args)).rows[0] as ApiCategory;
  })),
 };
}
