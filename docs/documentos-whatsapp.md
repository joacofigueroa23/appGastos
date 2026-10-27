# Comprobantes por WhatsApp (Fase 2)

Un integrante manda una foto o un PDF (ticket, factura, comprobante de pago, resumen de tarjeta). El sistema lo lee con Gemini y arma un **borrador**. Nada se registra hasta que la persona confirma.

## Principios

- **Leer un documento no es pagarlo.** Una factura con vencimiento futuro es una obligación pendiente, no un gasto. Un ticket documenta una compra ya hecha. Un resumen de tarjeta puede traer consumos ya cargados.
- Gemini interpreta y propone. **No autoriza ni guarda.** El backend valida todo (importes, fechas, categorías, tipo) y la persona confirma.
- El contenido del documento es **dato no confiable**: no puede dar órdenes ni cambiar reglas.
- Cada movimiento económico cuenta **una sola vez**.

## Flujo

`WhatsApp → webhook (HMAC) → bandeja durable → worker de documentos → Gemini → borrador (needs_review) → confirmar | cancelar`

Estados: `received → processing → needs_review → confirmed | cancelled | failed`. Hay reintentos con espera (máx. 3), lease para recuperarse de caídas y vencimiento del borrador (7 días por defecto) que borra la extracción.

## Qué hace cada tipo

| Tipo | Al confirmar |
|---|---|
| Ticket / compra | Crea un gasto (pagado) con ítems y categorías; o lo vincula a un gasto ya cargado (misma moneda, importe exacto, ±3 días). |
| Factura pendiente | **Nunca crea gasto.** Un administrador la asocia a un gasto fijo existente (actualiza monto y vencimiento previstos) o **crea una obligación nueva** de una cuota con el importe y el vencimiento de la factura. Sigue sin pagar. |
| Comprobante de pago | Se vincula al gasto existente si lo hay; si no, crea el gasto. |
| Resumen de tarjeta / planilla | Solo revisión en web. Consumos con coincidencia quedan excluidos. **Cuotas:** la cuota 1 registra la compra completa (cuota × meses) con la cantidad de meses; las cuotas 2 en adelante no se importan (ya estaban contadas). **Devoluciones:** restan del gasto original que el usuario elige entre candidatos (mismo comercio, importe mayor); sin original no se importan. **Pagos del resumen y transferencias propias:** no son gasto. |

El total declarado nunca se modifica: una diferencia entre ítems y total aparece como ítem de "ajuste" visible que la persona debe clasificar. La suma de ítems = monto del gasto está garantizada por un trigger de base.

## Una categoría por ticket, ajustes dentro del total y preguntas

- **Un ticket entra COMPLETO en una sola categoría** (la del comprobante: un súper entero es «Supermercado», aunque traiga leche y detergente; una carga de nafta es «Combustible»). No se reparte renglón por renglón. Si querés separar algo, es explícito: «el detergente va en limpieza» (los demás renglones quedan en la categoría del ticket).
- **IVA, redondeo, descuentos, recargos y diferencias NO llevan categoría propia ni preguntas:** son parte del total del ticket y siguen su categoría. Un renglón «Redondeo -0,32», un campo de redondeo, o una diferencia menor a $1 se muestran como «Redondeo — -$0,32 (incluido en el total)». **El total declarado es lo que se registra**, siempre.
- Si los renglones no suman el total y nada lo explica (por ejemplo $20.000 vs $21.000), el bot registra igual el total completo y lo avisa en el resumen («Los renglones suman $20.000 y el total es $21.000: registro el total completo. Si falta algún renglón, no pasa nada») por si algo se leyó mal; no pregunta.
- **Cuando de verdad falta un dato, pregunta una cosa por vez, en este orden:** total → fecha → categoría (una sola, para todo el ticket) → medio de pago. Se responde con una palabra: «ayer», «20 mil», «Combustible», o «todo en supermercado». Responder no registra: falta el «confirmar» (o el registro automático, si está activo y no hay dudas).
- Las respuestas cortas solo se toman como respuesta si hay **un** comprobante abierto, reciente y sin un gasto en curso, y si encajan con lo que se preguntó; un gasto nuevo («gasté 500 en el kiosco…») sigue su camino.
- Los avisos técnicos de la lectura se dicen en simple («No pude leer el importe de un renglón») y los importes negativos se muestran bien («-$0,32»). En la web hay un selector «Categoría de todo el ticket».

## Subir archivos desde la web (fotos, PDF, CSV, Excel)

La pantalla Comprobantes tiene «Subir archivo». Acepta foto (JPG/PNG), PDF, `.csv` y `.xlsx` (primera hoja, hasta 200 filas de datos y 5 MB). Se lee en el momento, **no se guarda el archivo ni su nombre**, y queda un borrador para revisar: cada fila se clasifica por categoría y la pantalla muestra el total por categoría de lo seleccionado. Nada se registra hasta confirmar. Requiere sesión de integrante (con Basic Auth no se puede subir). El mismo archivo no se procesa dos veces. Las planillas se leen sin dependencias externas (un `.xlsx` es un ZIP con XML) con tope de tamaño descomprimido; fórmulas y macros no se ejecutan, solo se leen valores.

## Registro automático por el bot

Un **ticket o comprobante de pago completo** (importe, fecha, categorías y medio de pago válidos) que no coincide con un gasto ya cargado y no es «no es gasto» **se registra solo** y el bot avisa («✅ Registrado… en Ropa. Si está mal, respondé *deshacer*»). Si falta algo, no registra: dice qué falta y, si es la categoría, «No tengo una categoría para X» con la lista de las tuyas; al responder «el suéter va en ropa» (o completar el dato que falte) lo registra en ese momento. Si hay un gasto parecido propio, pregunta si vincular en vez de duplicar. Facturas y resúmenes de tarjeta **nunca** se registran solos.

**Deshacer:** «deshacer» borra el último gasto que registraste por comprobante (solo de la última hora y solo el tuyo) y deja el comprobante descartado. Para apagar el registro automático: `DOCUMENT_AUTO_REGISTER=false`.

## Comandos de chat (sin Gemini)

`confirmar [código]`, `cancelar [código]`, `es personal` / `es del hogar`, `efectivo` / tarjeta, `fecha 10/10`, `total 19.000`, `no es un gasto`, `vincular`, `es una factura` / `es un ticket`, `excluir <ítem>`, `<ítem> va en <categoría>`. Con varios borradores abiertos se usa el código de 4 caracteres. Un "ok" suelto solo confirma un borrador reciente y sin conversación de gasto abierta.

## Privacidad y permisos

- Cada integrante ve y opera **solo sus documentos**. El administrador además **revisa** las facturas pendientes de otros, pero no las reclasifica ni registra gastos a nombre de ellos.
- Las coincidencias de duplicados solo buscan entre gastos que el actor puede ver; solo el administrador ve quién cargó el gasto coincidente.
- Un integrante no se entera de las obligaciones (gastos fijos).
- No se guarda el nombre del archivo. Al cancelar o vencer, se borran `extraction` y `draft`. El archivo en sí no se almacena: se descarga de Meta, se manda a Gemini y se descarta.
- Se envía a Gemini únicamente la imagen/PDF y el prompt fijo. No se envían datos de la familia.

## Endpoints

`POST /api/documents/upload` (`{filename, contentBase64}`), `GET /api/documents`, `GET /api/documents/:id`, `PATCH /api/documents/:id` (dueño), `POST /api/documents/:id/confirm` (`occurrenceId` o `newFixedCategoryId` para facturas), `POST /api/documents/:id/cancel`, `GET /api/documents/metrics?days=30` (admin; estados, errores, reintentos, duración, tokens, costo estimado; sin contenido).

## Configuración

Obligatorias para leer documentos: `GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID` (las mismas de la Fase 1).

Opcionales (valor por defecto entre paréntesis): `GEMINI_DOCUMENT_MODEL`, `DOCUMENT_MAX_IMAGE_BYTES` (5 MB), `DOCUMENT_MAX_PDF_BYTES` (10 MB), `DOCUMENT_MAX_PDF_PAGES` (10), `DOCUMENT_MAX_ITEMS` (80), `DOCUMENT_MAX_LINES` (200), `DOCUMENT_TIMEOUT_MS` (60000), `DOCUMENT_MAX_ATTEMPTS` (3), `DOCUMENT_MAX_PER_HOUR` (20 por integrante), `DOCUMENT_DRAFT_TTL_HOURS` (168), `DOCUMENT_AUTO_REGISTER` (activo; `false` lo apaga), `GEMINI_INPUT_PRICE_PER_MTOK` / `GEMINI_OUTPUT_PRICE_PER_MTOK` (para estimar costo; sin ellos no se estima).

## Guía de despliegue (requiere autorización explícita)

1. Revisar la migración `supabase/migrations/20261022120000_documents.sql`. Es aditiva (tablas nuevas, columnas nuevas, una vista y triggers); no borra datos.
2. **Respaldo** de la base antes de aplicarla. Confirmar que el compañero no tenga migraciones en paralelo.
3. Aplicar la migración en Supabase y verificar `documents`, `expense_items`, `expense_lines` y `expenses.document_id`.
4. Cargar las variables de entorno en Render (sin commitear secretos). Confirmar que el número de WhatsApp tenga permiso de recibir media.
5. Desplegar `main` en Render. Probar con un ticket sintético propio y cancelarlo; luego con una factura de prueba y verificar que **no** crea gasto.
6. Mirar `/api/documents/metrics` los primeros días (fallos, reintentos, costo).

**Rollback:** el código nuevo es inofensivo sin la migración solo si no se activa la lectura; para desactivar sin revertir, quitar `GEMINI_API_KEY` (los documentos quedan en cola/fallan con aviso). Para volver atrás por completo: redeploy del commit anterior; las tablas nuevas pueden quedar sin uso. Los gastos con ítems ya creados siguen contando bien porque presupuestos y consultas leen de la vista `expense_lines`.

## Límites y riesgos conocidos

- Gemini puede leer mal; por eso siempre hay borrador y confirmación. Calidad real con fotos reales **no validada** (las pruebas usan documentos sintéticos y un modelo simulado).
- Sin OCR propio: si Gemini no está disponible, el documento falla con aviso y reintenta.
- Los duplicados se detectan por importe exacto + fecha cercana + moneda; un mismo importe en la misma semana puede dar un falso positivo (por eso solo se propone, nunca se fusiona).
- Resumen de tarjeta: una consulta de duplicados por línea (hasta 200 líneas).

## Decisiones contables (aprobadas)

1. **Cuotas:** la compra se registra una vez, al inicio, por el total (cuota × meses) y con la cantidad de meses (`expenses.installments`). Si el resumen no incluye la cuota 1, la compra no se registra sola: cargala a mano.
2. **Devoluciones:** restan del gasto original (`amount` queda neto y `refunded_amount` guarda cuánto se devolvió; si el gasto tiene conceptos, se agrega uno negativo). Una devolución **total** no se aplica: el gasto original tendría importe 0; se resuelve borrándolo desde el Historial.
3. **Transferencias propias y pago de tarjeta:** no son gasto.
4. **Factura sin gasto fijo:** el administrador puede crear la obligación pendiente (una cuota).

Límites conocidos: la búsqueda del gasto original usa la primera palabra del comercio (4+ letras); si el comercio del resumen se escribe muy distinto, hay que cargar el ajuste a mano.
