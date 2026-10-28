# Bot conversacional V3: contexto, interpretación flexible y lectura confiable

## Diagnóstico (causas comprobadas)
- **Caso A (pérdida de contexto):** la respuesta a un comprobante abierto solo se entendía si era una palabra o frase exacta («Supermercado», «confirmar»). Un mensaje con dos datos («Supermercado confirmar») no encajaba, caía al flujo de gasto nuevo y abría «¿Cuánto gastaste?». Con ese gasto abierto, «confirmar» y «cancelar» pasaban a ser del gasto y el comprobante quedaba trabado.
- **Caso B (lectura incorrecta de un comprobante de Mercado Pago):** no es una mezcla de documentos por código (cada lectura es independiente). La causa probable es una mala lectura del modelo sobre una foto difícil, sin ninguna verificación posterior. El aviso «No se pudo determinar el comercio» lo escribe el modelo. Lo que se agregó: evidencia literal, validación y segunda lectura (ver abajo).

## Árbitro de contexto (`documents/focus.ts`)
Orden para un texto: consulta financiera → acción de administración pendiente → comando exacto de comprobante → **árbitro** → flujo de administración → gasto nuevo.
1. **Recuperación:** «¿qué tengo pendiente?», «cancelá todo» / «empezar de nuevo», «volvamos al ticket», «ese gasto no» / «me equivoqué». Cancelar nunca toca lo ya registrado.
2. **Mensajes compuestos** con un comprobante abierto («Supermercado confirmar», «ponelo en comida y guardalo», «fue para la casa, efectivo», «No, fueron 12000, no 35689», «2»). Se descomponen por reglas; **todo o nada**: si una parte no se entiende no se aplica ninguna.
3. **Respaldo con Gemini** (`documents/turn.ts`) solo si las reglas no entienden y el mensaje no parece un gasto nuevo. Una sola consulta, sin reintentos. El backend valida categoría real, fecha, total, y exige palabras de confirmación/descarte en el texto del usuario.
4. Con **varios comprobantes** abiertos, un mensaje con datos no se aplica a ninguno: se pide el código.
5. Una frase corta sin importe con un comprobante esperando no abre un gasto nuevo.

## Lectura confiable (`documents/extraction.ts`)
- El modelo devuelve además `provider`, `recipient`, `time` y `evidence` (texto literal del total y la fecha). **Mercado Pago/bancos/billeteras son proveedor, nunca comercio**; el vendedor es el destinatario. El medio de pago no se deduce del logo.
- `readingProblems` cruza el valor normalizado con lo literal (formato argentino `11.600,00`), y revisa que total y fecha sean plausibles.
- Si hay inconsistencia: **una** segunda lectura (modelo opcional `GEMINI_DOCUMENT_RETRY_MODEL`). Si persiste, el borrador queda con `doubt`: se muestra el aviso, **no se registra solo**, y corregir total/fecha lo limpia. Nunca se inventan importes.

## Categorización asistida (`documents/rules.ts`, migración `20261025120000_category_rules.sql`)
- Reglas por comercio aprendidas **solo** de categorías que el usuario eligió y confirmó. Gasto de la casa → regla de la familia; si no, personal.
- Un ticket de compra con comercio conocido entra con la categoría aprendida (queda avisado). Los pagos a personas («Brenda») nunca se categorizan solos: ofrecen hasta 3 opciones numeradas y «otra».
- «mis reglas» las lista y «olvidá la regla de X» las borra (el administrador, también las de la familia).

## Botones de WhatsApp
Se derivan del texto de la respuesta (el texto siempre viaja completo): opciones numeradas, Confirmar/Cancelar y Deshacer. El toque vuelve como un comando de texto (`confirmar CODIGO`, `cancelar CODIGO`, número, `deshacer`) y pasa por las mismas validaciones. Si Meta rechaza los botones, sale el texto solo. Formato verificado en la documentación de Meta (interactive/button, máx. 3 botones, título 20, cuerpo 1024).

## Observabilidad
`shared/trace.ts` emite una línea JSON por decisión (`bot_focus`, `doc_read`) con ruta, tipos de edición y códigos; **sin** texto, importes ni comercios. `BOT_TRACE=off` la apaga.

## Para desplegar
1. Aplicar la migración `supabase/migrations/20261025120000_category_rules.sql`.
2. Opcional: `GEMINI_DOCUMENT_RETRY_MODEL` (modelo más fuerte para la segunda lectura), `BOT_TRACE=off`.
3. Después de desplegar, probar con fotos reales (la calidad de la lectura de Gemini no se puede verificar en las pruebas, que usan un modelo simulado).

## Límites conocidos
- La lectura depende del modelo: una foto inclinada o con reflejo puede seguir leyéndose mal; ahora se detecta si es inconsistente, pero no si el modelo se equivoca de forma coherente.
- Los botones no cubren todas las preguntas, solo las derivables del texto.
