import type {PaymentCode} from '../../shared/apiTypes';

// Campos que la conversación puede preguntar, en el orden en que se preguntan.
// date solo se pregunta si el usuario dio una fecha explícita no resoluble.
export const QUESTION_ORDER=['amount','paymentMethod','card','category','date'] as const;
export type DraftField=(typeof QUESTION_ORDER)[number];

// Valor del borrador con el fragmento del mensaje que lo respalda (no el texto completo).
export interface Evidenced<T>{value:T;evidence:string|null}
export interface ExpenseDraft{
 referenceDate:string;                // fecha del primer mensaje en APP_TIME_ZONE
 amount?:Evidenced<string>;           // decimal canónico
 currency?:Evidenced<string>;         // solo si fue explícita
 date?:Evidenced<string>;             // solo si fue explícita
 merchant?:Evidenced<string>;
 description?:Evidenced<string>;
 category?:Evidenced<string>;         // id de categoría
 paymentMethod?:Evidenced<PaymentCode>;
 card?:Evidenced<string|null>;        // id de tarjeta; null = "ninguna"
 require?:DraftField[];               // campos con error que exigen una respuesta explícita
 options?:(string|null)[];            // ids de la última lista numerada; null = "Ninguna"
}
export type PatchField='amount'|'currency'|'date'|'merchant'|'description'|'category'|'paymentMethod'|'card';
export type DraftPatch=Partial<Pick<ExpenseDraft,PatchField>>;
export const PATCH_FIELDS:readonly PatchField[]=['amount','currency','date','merchant','description','category','paymentMethod','card'];
// description se deriva del mensaje inicial: no cuenta como dato nuevo ni como corrección.
const COMPARABLE:readonly PatchField[]=PATCH_FIELDS.filter(f=>f!=='description');

const sameValue=(a:Evidenced<unknown>|undefined,b:Evidenced<unknown>|undefined)=>a!==undefined&&b!==undefined&&a.value===b.value;
// Campos del parche que reemplazarían un valor distinto ya cargado.
export function overwrittenFields(draft:ExpenseDraft,patch:DraftPatch):PatchField[]{
 return COMPARABLE.filter(f=>patch[f]!==undefined&&draft[f]!==undefined&&!sameValue(draft[f],patch[f]));
}
// Campos del parche que aportan información (nuevos o distintos).
export function informativeFields(draft:ExpenseDraft,patch:DraftPatch):PatchField[]{
 return COMPARABLE.filter(f=>patch[f]!==undefined&&!sameValue(draft[f],patch[f]));
}
export function withoutFields(patch:DraftPatch,fields:readonly PatchField[]):DraftPatch{
 const out={...patch};for(const f of fields)delete out[f];return out;
}

// Aplica un parche ya validado. Conserva todo lo no mencionado en el parche.
export function applyCandidatePatch(draft:ExpenseDraft,patch:DraftPatch,required:readonly DraftField[]=[]):ExpenseDraft{
 const next:ExpenseDraft={...draft};
 Object.assign(next,Object.fromEntries(PATCH_FIELDS.filter(f=>patch[f]!==undefined).map(f=>[f,patch[f]])));
 // Un comercio corregido invalida la descripción derivada del anterior.
 if(patch.merchant&&draft.merchant&&patch.merchant.value!==draft.merchant.value&&!patch.description)delete next.description;
 // Un medio que no es tarjeta descarta la tarjeta elegida.
 if(patch.paymentMethod&&!['credit_card','debit_card'].includes(patch.paymentMethod.value)&&!patch.card)delete next.card;
 // Un campo exigido deja de serlo cuando el parche lo responde.
 const require=new Set((draft.require||[]).filter(f=>patch[f]===undefined));
 for(const f of required)require.add(f);
 if(require.size)next.require=[...require];else delete next.require;
 delete next.options;
 return next;
}
