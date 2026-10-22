import type {ApiCategory} from '../shared/apiTypes';
// Categorías principales y subcategorías (dos niveles): en las listas se muestran "Principal › Sub" y las subcategorías van debajo de su principal.
export const categoryLabel=(c:Pick<ApiCategory,'name'|'parentId'>,all:Pick<ApiCategory,'id'|'name'>[])=>{
 const parent=c.parentId?all.find(x=>x.id===c.parentId):undefined;
 return parent?parent.name+' › '+c.name:c.name;
};
export function sortedCategories<T extends Pick<ApiCategory,'id'|'name'|'parentId'>>(list:T[]):T[]{
 const byName=(a:T,b:T)=>a.name.localeCompare(b.name,'es');
 const roots=list.filter(c=>!c.parentId||!list.some(p=>p.id===c.parentId)).sort(byName);
 return roots.flatMap(r=>[r,...list.filter(c=>c.parentId===r.id).sort(byName)]);
}
