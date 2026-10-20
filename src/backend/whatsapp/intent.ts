import {emptyInterpretation,normalizeName,normalizeTextAmount,paymentEvidence,resolveDate,type CardEntry,type CatalogEntry,type Interpretation} from './candidate';
import {informativeFields,overwrittenFields,withoutFields,type DraftField,type DraftPatch,type ExpenseDraft} from './draft';

// Reglas deterministas de la conversación. Tienen prioridad sobre Gemini.

const clean=(text:string)=>normalizeName(text).replace(/[.,;:!?¡¿"']/g,' ').replace(/\s+/g,' ').trim();

// El mensaje debe EMPEZAR con la expresión: "cancelé la tarjeta" no cancela.
const CANCEL=/^(cancelar|cancela|cancelalo|cancelo|no lo cargues|no lo registres|olvidalo|olvidate|dejalo)\b/;
export function isCancel(text:string):boolean{return CANCEL.test(clean(text));}

// Gasto de la casa solo con expresión explícita; nunca por categoría o comercio ("Pagué el colegio de la casa").
const HOUSEHOLD=/\b(de la casa|del hogar|para la casa|para el hogar)\b/;
export function householdMarker(text:string):boolean{return HOUSEHOLD.test(clean(text));}

const CORRECTION=/\b(perdon|me equivoque|me confundi|en realidad|corrijo|correccion|no fue|no era)\b/;
export function hasCorrectionMarker(text:string):boolean{return CORRECTION.test(clean(text));}

// "perdón, fue con tarjeta": corrige el medio a tarjeta sin decir crédito/débito ni cuál.
// El medio anterior deja de valer y se vuelve a preguntar; nunca se elige crédito o débito por defecto.
export function genericCardCorrection(text:string,cards:CardEntry[]):boolean{
 return hasCorrectionMarker(text)&&/\btarjeta\b/.test(clean(text))&&paymentEvidence(text)===null&&cardNamed(text,cards)===null;
}

export type Intent='answer'|'correct'|'conflict'|'unknown';
// Clasifica un parche ya validado frente al borrador actual.
// - campo vacío: siempre se completa;
// - campo cargado + frase de corrección: corrección;
// - dos o más campos cargados sin frase de corrección: otro gasto (conflicto, no se aplica nada);
// - un campo cargado sin frase de corrección: se ignora ese campo.
// El campo preguntado nunca cuenta como reemplazo.
export function classifyPatch(draft:ExpenseDraft,patch:DraftPatch,text:string,expected:DraftField|null):{intent:Intent;patch:DraftPatch}{
 const replaced=overwrittenFields(draft,patch).filter(f=>f!==expected);
 if(replaced.length&&hasCorrectionMarker(text))return {intent:'correct',patch};
 if(replaced.length>=2)return {intent:'conflict',patch:{}};
 const kept=withoutFields(patch,replaced);
 return informativeFields(draft,kept).length?{intent:'answer',patch:kept}:{intent:'unknown',patch:{}};
}

export type DeterministicAnswer={kind:'interpretation';raw:Interpretation}|{kind:'patch';patch:DraftPatch}|null;
const SHORT=4;
// Nombre de tarjeta activa contenido como palabras completas; el más largo gana ("visa galicia" sobre "visa").
function cardNamed(text:string,cards:CardEntry[]):string|null{
 const t=' '+clean(text)+' ';
 return cards.filter(c=>c.active&&t.includes(' '+normalizeName(c.name)+' ')).sort((a,b)=>b.name.length-a.name.length)[0]?.name??null;
}
function option(text:string,options:(string|null)[]|undefined):{found:boolean;id:string|null}{
 const t=clean(text);
 if(!options||!/^\d{1,2}$/.test(t))return {found:false,id:null};
 const index=Number(t)-1;
 return index>=0&&index<options.length?{found:true,id:options[index]}:{found:false,id:null};
}
// Respuesta corta al campo preguntado, resuelta sin IA. null: no alcanza, se usa Gemini.
export function deterministicAnswer(expected:DraftField|null,text:string,draft:ExpenseDraft,catalog:{categories:CatalogEntry[];cards:CardEntry[]}):DeterministicAnswer{
 if(!expected)return null;
 const trimmed=text.trim().replace(/[.!]+$/,'').trim(),t=clean(text),words=t?t.split(' ').length:0;
 const raw=emptyInterpretation();
 switch(expected){
  case 'amount':{
   if(!/^\$?\s*\d[\d.,]*\s*(mil|k|lucas?)?$/i.test(trimmed))return null;
   const amount=normalizeTextAmount(trimmed);
   if(!amount)return null;
   raw.amount=amount;raw.amountText=trimmed;return {kind:'interpretation',raw};
  }
  case 'paymentMethod':
  case 'card':{
   if(expected==='card'){
    if(/^(ninguna|ninguno|sin tarjeta|no)$/.test(t))return {kind:'patch',patch:{card:{value:null,evidence:trimmed}}};
    const picked=option(text,draft.options);
    // La lista solo ofrece tarjetas activas compatibles con el medio; validateDraft vuelve a comprobarlo.
    if(picked.found)return {kind:'patch',patch:{card:{value:picked.id,evidence:trimmed}}};
   }
   if(words>SHORT)return null;
   const method=paymentEvidence(text),card=cardNamed(text,catalog.cards);
   if(!method&&!card)return null;
   raw.paymentMethod=method;raw.paymentMethodText=method?text:null;raw.card=card;
   return {kind:'interpretation',raw};
  }
  case 'category':{
   const picked=option(text,draft.options);
   const category=picked.found?catalog.categories.find(c=>c.id===picked.id):
    words<=SHORT?catalog.categories.find(c=>c.active&&normalizeName(c.name)===normalizeName(trimmed)):undefined;
   if(!category)return null;
   raw.category=category.name;return {kind:'interpretation',raw};
  }
  case 'date':{
   if(!t||resolveDate(trimmed,draft.referenceDate)===null)return null;
   raw.dateText=trimmed;return {kind:'interpretation',raw};
  }
 }
}
