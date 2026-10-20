import {ApiError} from '../shared/errors';
import type {SessionMember} from './session';
export type Role='admin'|'member';
// Quién hace el pedido. Con sesión individual sale de la base (nunca del cliente). Sin ella (Basic Auth, una credencial
// compartida) el acceso equivale a administrador, que es lo que ya tenía; se retira junto con Basic Auth.
export interface Actor {role:Role;memberId:string|null}
export const actorOf=(res:{locals:Record<string,any>;app?:{locals:Record<string,any>}}):Actor=>{
 const member=res.locals.member as SessionMember|undefined;
 if(member)return {role:member.role,memberId:member.id};
 // Con sesión individual activa, una ruta que llegue sin integrante resuelto (montada antes de sessionAuth) no es administrador.
 if(res.app?.locals.requireSession)throw new ApiError(401,'Iniciá sesión para continuar.');
 return {role:'admin',memberId:null};
};
export function requireAdmin(actor:Actor):void{
 if(actor.role!=='admin')throw new ApiError(403,'Esta operación es solo para administradores.');
}
// Única regla de visibilidad de gastos: un member solo ve lo que él registró; el administrador ve todo.
// Devuelve el autor al que hay que limitar la consulta, o undefined si no hay límite.
export const visibleAuthor=(actor?:Actor):string|undefined=>actor&&actor.role==='member'?actor.memberId??'00000000-0000-0000-0000-000000000000':undefined;
