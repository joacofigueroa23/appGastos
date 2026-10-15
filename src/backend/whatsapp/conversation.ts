import type {Connection} from '../expenses/repository';
import type {DraftField,ExpenseDraft} from './draft';

// Persistencia de ConversationSession + ExpenseDraft (una fila por conversación).
export type ConversationStatus='active'|'confirmed'|'cancelled'|'expired'|'error';
export interface Conversation {
 id:string;familyId:string;memberId:string;status:ConversationStatus;draft:ExpenseDraft;
 expectedField:DraftField|null;unknownCount:number;version:number;expiresAt:Date;
}
const columns='id,family_id AS "familyId",member_id AS "memberId",status,draft,expected_field AS "expectedField",unknown_count AS "unknownCount",version,expires_at AS "expiresAt"';

export async function findActiveConversation(db:Connection,familyId:string,memberId:string,lock=false):Promise<Conversation|null>{
 const r=await db.query('SELECT '+columns+' FROM appgastos.whatsapp_conversations WHERE family_id=$1 AND member_id=$2 AND status=\'active\''+(lock?' FOR UPDATE':''),[familyId,memberId]);
 return r.rows[0]??null;
}
// Expiración perezosa: se evalúa con la hora del mensaje que llega, sin proceso aparte.
export async function expireConversations(db:Connection,familyId:string,memberId:string,at:Date):Promise<void>{
 await db.query("UPDATE appgastos.whatsapp_conversations SET status='expired',closed_at=now(),updated_at=now() WHERE family_id=$1 AND member_id=$2 AND status='active' AND expires_at<=$3",[familyId,memberId,at]);
}
export async function createConversation(db:Connection,input:{familyId:string;memberId:string;draft:ExpenseDraft;expectedField:DraftField|null;expiresAt:Date}):Promise<Conversation>{
 const r=await db.query('INSERT INTO appgastos.whatsapp_conversations(family_id,member_id,draft,expected_field,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING '+columns,
  [input.familyId,input.memberId,JSON.stringify(input.draft),input.expectedField,input.expiresAt]);
 return r.rows[0];
}
export async function saveConversation(db:Connection,id:string,input:{draft:ExpenseDraft;expectedField:DraftField|null;unknownCount:number;expiresAt?:Date}):Promise<void>{
 await db.query('UPDATE appgastos.whatsapp_conversations SET draft=$2,expected_field=$3,unknown_count=$4,expires_at=COALESCE($5,expires_at),version=version+1,updated_at=now() WHERE id=$1',
  [id,JSON.stringify(input.draft),input.expectedField,input.unknownCount,input.expiresAt??null]);
}
export async function closeConversation(db:Connection,id:string,status:Exclude<ConversationStatus,'active'>,expenseId:string|null=null):Promise<void>{
 await db.query('UPDATE appgastos.whatsapp_conversations SET status=$2,expense_id=$3,expected_field=NULL,version=version+1,closed_at=now(),updated_at=now() WHERE id=$1',[id,status,expenseId]);
}
// Último gasto que ESTE integrante registró por WhatsApp desde este número, si fue dentro de la ventana.
// Solo el último: un gasto anterior nunca se corrige aunque esté dentro de la ventana.
export async function findCorrectableExpense(db:Connection,input:{familyId:string;sender:string;memberId:string;at:Date;windowMinutes:number}):Promise<string|null>{
 const r=await db.query("SELECT m.expense_id AS id,COALESCE(m.meta_timestamp,m.received_at) AS registered_at FROM appgastos.whatsapp_messages m JOIN appgastos.expenses e ON e.id=m.expense_id"+
  " WHERE m.family_id=$1 AND m.sender=$2 AND m.outcome='registered' AND e.family_id=$1 AND e.reported_by_member_id=$3 AND e.source='whatsapp'"+
  " ORDER BY COALESCE(m.meta_timestamp,m.received_at) DESC LIMIT 1",[input.familyId,input.sender,input.memberId]);
 const last=r.rows[0];if(!last)return null;
 const elapsed=input.at.getTime()-new Date(last.registered_at).getTime();
 return elapsed>=0&&elapsed<=input.windowMinutes*60000?last.id:null;
}
// Integrante desactivado o con otro teléfono a mitad de conversación: no puede continuar.
export async function failConversations(db:Connection,familyId:string,memberIds:string[]):Promise<void>{
 if(!memberIds.length)return;
 await db.query("UPDATE appgastos.whatsapp_conversations SET status='error',expected_field=NULL,version=version+1,closed_at=now(),updated_at=now() WHERE family_id=$1 AND member_id=ANY($2::uuid[]) AND status='active'",[familyId,memberIds]);
}
