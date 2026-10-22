import type {Connection} from '../expenses/repository';
import {normalizeName} from '../whatsapp/candidate';
import {generateOccurrences} from '../fixed/service';
import type {DraftLine,DuplicateRef,ReceiptDraft,StatementDraft} from './types';
// Coincidencias financieras con gastos ya cargados: misma moneda, mismo importe exacto y fecha cercana.
// Solo ve gastos que el pedido tiene permiso de ver (author = límite de un integrante) y solo el administrador ve quién los cargó:
// un integrante no descubre gastos ajenos por esta vía. Nunca se fusiona ni se borra nada: solo se ofrece vincular.
export async function findDuplicates(db:Connection,family:string,viewer:{author?:string;admin:boolean},q:{date:string;amount:string;currency:string},days=3):Promise<DuplicateRef[]>{
 const args:unknown[]=[family,q.currency,q.amount,q.date,days];
 const own=viewer.author?(args.push(viewer.author),' AND e.reported_by_member_id=$'+args.length):'';
 const rows=(await db.query(`SELECT e.id,to_char(e.date,'YYYY-MM-DD') AS date,e.amount::text AS amount,e.currency,COALESCE(e.merchant,e.description) AS label,m.name AS author
  FROM appgastos.expenses e LEFT JOIN appgastos.family_members m ON m.id=e.reported_by_member_id
  WHERE e.family_id=$1 AND e.currency=$2 AND e.amount=$3::numeric AND e.document_id IS NULL AND e.date BETWEEN $4::date-$5::int AND $4::date+$5::int${own}
  ORDER BY abs(e.date-$4::date),e.created_at LIMIT 3`,args)).rows;
 return rows.map(r=>({expenseId:r.id,date:r.date,amount:r.amount,currency:r.currency,label:String(r.label||'').slice(0,80),author:viewer.admin?r.author??null:null}));
}
// Gastos a los que una devolución podría restarse: mismo comercio (primera palabra significativa), misma moneda, anteriores a la devolución
// y de importe suficiente. Mismos límites de privacidad que los duplicados. Nunca se elige uno por el usuario.
export async function findRefundCandidates(db:Connection,family:string,viewer:{author?:string;admin:boolean},q:{date:string;amount:string;currency:string;merchant:string}):Promise<DuplicateRef[]>{
 const word=q.merchant.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().match(/[a-z]{4,}/)?.[0];
 if(!word)return [];
 const args:unknown[]=[family,q.currency,q.amount,q.date,'%'+word+'%'];
 const own=viewer.author?(args.push(viewer.author),' AND e.reported_by_member_id=$'+args.length):'';
 const rows=(await db.query(`SELECT e.id,to_char(e.date,'YYYY-MM-DD') AS date,e.amount::text AS amount,e.currency,COALESCE(e.merchant,e.description) AS label,m.name AS author
  FROM appgastos.expenses e LEFT JOIN appgastos.family_members m ON m.id=e.reported_by_member_id
  WHERE e.family_id=$1 AND e.currency=$2 AND e.amount>$3::numeric AND e.date<=$4::date AND e.date>$4::date-400 AND lower(COALESCE(e.merchant,'')||' '||e.description) LIKE $5${own}
  ORDER BY e.date DESC,e.created_at DESC LIMIT 3`,args)).rows;
 return rows.map(r=>({expenseId:r.id,date:r.date,amount:r.amount,currency:r.currency,label:String(r.label||'').slice(0,80),author:viewer.admin?r.author??null:null}));
}
export async function withReceiptDuplicates(db:Connection,family:string,viewer:{author?:string;admin:boolean},d:ReceiptDraft):Promise<ReceiptDraft>{
 if(!d.date||d.total===null)return {...d,duplicates:[],linkExpenseId:null};
 const duplicates=await findDuplicates(db,family,viewer,{date:d.date,amount:d.total,currency:d.currency});
 // Si hay UNA sola coincidencia, se propone vincularla (el usuario igual confirma). Con varias, no se elige por él.
 return {...d,duplicates,linkExpenseId:duplicates.length===1&&!d.noExpense?duplicates[0].expenseId:null};
}
const MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const tokens=(s:string)=>normalizeName(s).split(/[^a-z0-9]+/).filter(t=>t.length>=4);
// Un comprobante de pago que coincide en importe exacto y en nombre con UNA obligación fija pendiente de ese mes (o el contiguo): se propone
// saldarla. Solo para administradores (un integrante no ve obligaciones). Si ya hay un gasto parecido cargado, manda la vinculación (no se duplica).
export async function withFixedMatch(db:Connection,family:string,d:ReceiptDraft):Promise<ReceiptDraft>{
 if(!d.date||d.total===null||d.noExpense||d.duplicates.length||d.linkExpenseId)return d;
 // Las obligaciones del mes del comprobante y los contiguos se generan si faltan (idempotente).
 const month=d.date.slice(0,7),shift=(n:number)=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1+n,1)).toISOString().slice(0,7);
 await generateOccurrences(db,family,shift(-1),month);
 const rows=(await db.query(`SELECT o.id,o.expense_id,f.name,f.category_id AS "categoryId",to_char(o.period,'YYYY-MM') AS period FROM appgastos.fixed_expense_occurrences o JOIN appgastos.fixed_expenses f ON f.id=o.fixed_expense_id
  WHERE o.family_id=$1 AND f.currency=$2 AND o.expected_amount=$3::numeric AND o.period BETWEEN (date_trunc('month',$4::date)-interval '1 month')::date AND date_trunc('month',$4::date)::date`,[family,d.currency,d.total,d.date])).rows as {id:string;expense_id:string|null;name:string;categoryId:string;period:string}[];
 const words=new Set(tokens((d.merchant||'')+' '+d.description));
 const named=rows.filter(r=>tokens(r.name).some(t=>words.has(t)));
 // Manda la obligación del mes del comprobante (si ya está pagada o hay dudas, no se propone nada); solo si no hay ninguna de ese mes se mira la
 // del mes anterior (pago atrasado). El mes siguiente no se toca. Más de una candidata = ambiguo: no se propone.
 const prev=shift(-1),here=named.filter(r=>r.period===month),before=named.filter(r=>r.period===prev);
 // La obligación de ese mes ya figura pagada (con un gasto que ya tiene su comprobante): no se crea otro gasto. Si fuera otro pago, el usuario responde «es gasto».
 if(here.length===1&&here[0].expense_id)return {...d,noExpense:true,noExpenseReason:'«'+here[0].name+' de '+MONTHS[Number(month.slice(5,7))-1]+' de '+month.slice(0,4)+'» ya figura como pagado: no se crea otro gasto. Si es otro pago distinto, respondé *es gasto*.'};
 const open=(here.length?here:before).filter(r=>!r.expense_id);
 if(open.length!==1||(here.length?here:before).length!==1)return d;
 const o=open[0];
 return {...d,settle:{occurrenceId:o.id,categoryId:o.categoryId,label:o.name+' de '+MONTHS[Number(o.period.slice(5,7))-1]+' de '+o.period.slice(0,4)},
  items:d.items.map(i=>i.categoryId?i:{...i,categoryId:o.categoryId})};
}
export async function withStatementDuplicates(db:Connection,family:string,viewer:{author?:string;admin:boolean},d:StatementDraft):Promise<StatementDraft>{
 // shortcut: una consulta por línea (hasta DOCUMENT_MAX_LINES=200, ~1 s); con resúmenes más largos conviene una sola consulta por lote.
 const lines:DraftLine[]=[];
 for(const l of d.lines){
  if(l.kind==='refund'&&l.date){
   const refundCandidates=await findRefundCandidates(db,family,viewer,{date:l.date,amount:l.amount,currency:l.currency,merchant:l.merchant});
   // Con candidatos deja de estar bloqueada, pero sigue sin importarse hasta que el usuario elija el gasto original.
   lines.push(refundCandidates.length?{...l,refundCandidates,blockedReason:null,excluded:true}:l);continue;
  }
  if(l.blockedReason||!l.date){lines.push(l);continue;}
  const duplicates=await findDuplicates(db,family,viewer,{date:l.date,amount:l.amount,currency:l.currency});
  // Un consumo con coincidencia queda excluido hasta que el usuario decida importarlo igual.
  lines.push({...l,duplicates,excluded:duplicates.length>0?true:l.excluded});
 }
 return {...d,lines};
}
