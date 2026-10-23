# Control financiero familiar (Fase 3)

Dos controles independientes: **gastos fijos** (obligaciones recurrentes) y **presupuestos variables** (límites mensuales). Nada se resetea con procesos mensuales: todo se calcula por período.

## Reglas financieras

**Gastos fijos**
- Una obligación por gasto fijo activo y por mes (única por `fixed_expense_id + mes`; consultar de nuevo nunca duplica).
- Pendiente ≠ gasto. Se marca pagada solo cuando se registra el pago (un único gasto de la casa vinculado) o se vincula uno ya cargado.
- Las impagas de meses anteriores siguen visibles («Vencidas y deudas anteriores») hasta que se pagan.
- Cambiar el importe «desde un mes» (`effectiveFrom`) queda en `fixed_expense_amounts` y solo alcanza a obligaciones **sin pagar** desde ese mes; lo pagado y lo anterior no cambian. Una obligación que se genera después toma el importe vigente de su período.
- **Pago atrasado:** la obligación queda asociada a su mes de origen y el pago cuenta en el mes de su **fecha efectiva**. Sin duplicaciones (un gasto no puede pagar dos obligaciones).

**Presupuestos variables**
- **Base recurrente** (`budget_bases`): rige desde un mes y se renueva sola cada mes con el importe completo. Sin saldo trasladado. Cambiar la base no toca meses anteriores; «quitar desde este mes» agrega una fila de cierre (se conserva el historial).
- **Excepción de un mes** (`budgets`): reemplaza la base solo ese mes; quitarla vuelve a la base. Las filas mensuales que ya existían de la Fase 1 pasan a ser excepciones (no se modificó ningún dato).
- **Jerarquía (dos niveles):** el presupuesto de la categoría principal incluye a sus subcategorías; el total **no** suma padre + hijo. Un gasto de subcategoría consume su límite y el del padre; si no hay presupuesto padre, no se inventa. La suma de los límites de las subcategorías no puede superar el límite explícito del padre (se valida en el mes en que se modifica).
- **Los pagos de gastos fijos no consumen presupuestos variables** (vista `expense_lines.is_fixed`). Un gasto de la casa que todavía no está vinculado a una obligación cuenta como variable hasta que se vincula.
- Un ticket con conceptos de varias categorías reparte su importe una sola vez (vista `expense_lines`).

**Totales** (`GET /api/control/summary?month=`, solo administradores): fijos pagados · pendientes · vencidos · deudas anteriores · presupuesto · consumido · disponible · variables registrados · **total gastado = fijos pagados + variables registrados** (lo pendiente no es gasto).

## Categorías
Principales y subcategorías (máx. dos niveles). Solo administradores crean, renombran, reorganizan, archivan y reactivan (`POST/PATCH /api/categories`); los integrantes las usan al registrar gastos. **Nunca se borran** (la base lo impide si hay referencias) y reorganizar no reclasifica movimientos: los gastos apuntan al id. Los nombres son únicos en toda la familia (restricción heredada de la Fase 1). Un trigger impide un tercer nivel o ciclos.

## WhatsApp (administradores)
El bot ampliado interpreta con Gemini (solo la intención y los datos literales); el backend valida, resuelve nombres a ids, guarda una **acción pendiente** con código (`admin_actions`, una por administrador, vence en 15 min) y **recién al confirmar** ejecuta con los mismos servicios que la web.
Ejemplos: «Creá la subcategoría Verdulería dentro de Alimentación», «Poné $500.000 presupuesto para Alimentación», «Agregá el colegio como gasto fijo de $180.000, vence el día 10» (pregunta la categoría si falta), «Desde diciembre el colegio cuesta $200.000», «Ya pagué el colegio de noviembre» (identifica la obligación; pregunta el medio de pago; ambigüedad → pregunta el mes; ya pagada → no registra nada).
Consultas deterministas: «¿Cuánto tengo pendiente de gastos fijos?», «¿Cuánto me queda del presupuesto de comida?».
- Rol e identidad salen del número vinculado. Un integrante que pide configurar recibe «solo para administradores» sin llamar a Gemini.
- Idempotente: confirmar dos veces (o reprocesar el mensaje) no aplica dos veces; un pedido nuevo reemplaza al pendiente; un error de negocio al confirmar no deja nada a medias.
- Gemini nunca ejecuta SQL ni decide permisos.

## Conversación del administrador (memoria y flexibilidad)
- **Pedido a medias con memoria:** si falta un dato (importe, día de vencimiento, categoría, mes, nombre), el bot guarda lo ya dicho (`admin_actions` en estado «juntando datos»), hace la pregunta y la próxima respuesta lo completa. «Registrar gasto fijo de 100000 en impuestos» → «¿Qué día del mes vence?» → «Vence el 10» → propone el gasto fijo (con la categoría «Impuestos & Seguros» deducida del nombre) y recién ahí pide confirmar. Las respuestas cortas («el 10», «250 mil», «Educación») se entienden con reglas simples, sin llamar a Gemini; las largas las interpreta Gemini con el pedido pendiente como contexto.
- **Verbos coloquiales** (anotá, sumá, cargá, registrá, definí, fijá…) y frases que empiezan con el tema («Presupuesto mascotas 250mil», «Gasto fijo colegio…») se tratan como configuración, no como gasto. Un integrante recibe «solo para administradores».
- «Cancelar», «olvidalo» o «no» descartan el pedido. Un pedido distinto reemplaza al anterior y no hereda sus datos. Si el mensaje parece un gasto («gasté 10 en…») durante una pregunta, no se toma como respuesta.
- **Foto de una lista** (presupuestos por categoría o gastos fijos, escrita a mano o impresa): Gemini la lee, el bot arma **una sola acción** con todas las líneas, hace coincidir los nombres con tus categorías («Super» → «Supermercado»), marca lo que no entendió y pide un solo «confirmar». Para presupuestos, «crear» también crea las categorías que no existen. Un gasto fijo sin día de vencimiento o sin categoría queda afuera y se avisa (se carga después por texto). Un integrante que manda la foto recibe «solo los administradores pueden configurarlo». No se guarda la imagen.

### Correcciones, cambios de tema y reintentos
- **Corregir antes de confirmar:** con el pedido ya listo, una respuesta corta lo corrige sin cambiar de pedido ni empezar de nuevo: «no, son 120 mil», «mejor el 15», «en Educación», «fue ayer» (en un pago). Las correcciones largas las interpreta Gemini y solo se aceptan si son del mismo tipo de pedido.
- **Fecha del pago:** «lo pagué ayer / el 8 / 8/10» queda como fecha efectiva (nunca futura). Si no se entiende, el bot pregunta.
- **Cambiar de tema:** un pedido de configuración claro reemplaza al que estaba a medias (sin heredar sus datos). Una frase ajena no pierde el borrador: el bot repite la pregunta. Con un gasto en curso (Fase 1), «efectivo», «sí» o «el 10» siguen siendo de ese gasto, pero un pedido de configuración claro igual se atiende.
- **Si Gemini no responde** y el pedido es claramente de configuración, el bot pide reintentar: nunca lo trata como un gasto.
- **Listas pendientes:** la propuesta muestra lo que ya existe («ya tenías $100.000», «ya existe»); se puede sacar una línea («sacá ocio») o corregirla («ropa 250 mil», «colegio vence el 10», «colegio en Educación») antes del «confirmar».
- **Intención escrita con el archivo:** «Estos son mis presupuestos», «son gastos fijos», «pagué el colegio», «es una factura»… junto a una imagen o PDF pesa más que la clasificación del modelo (se guarda solo una etiqueta cerrada, no el texto). Si el archivo es ambiguo, el bot ofrece también *presupuestos* y *gastos fijos*, y se responde con una palabra.
- **Clasificación de mensajes ambiguos:** un mensaje de administrador que no es un gasto evidente (no dice «gasté / pagué / compré») y no trae palabras de configuración también lo clasifica Gemini: «El colegio sale 180 mil y se paga el 10» → propuesta de gasto fijo para confirmar. Si no era configuración, sigue como gasto común, y un fallo de Gemini acá nunca bloquea un gasto. Cuesta una llamada extra solo en esos mensajes. Se apaga con `ADMIN_AI_ROUTING=keywords` (queda solo el filtro por palabras).
- **Textos más claros:** los avisos técnicos del flujo de gastos se dicen en simple («No entendí bien la fecha» en vez de «fecha inválida o ambigua»), el mensaje de ayuda menciona fotos y consultas, y el aviso de archivos no soportados ya no dice que no se leen imágenes.
- **Reintentos de WhatsApp y reinicios:** el mismo mensaje repetido no aplica dos veces y los pedidos pendientes viven en la base, así que un reinicio del servidor no los pierde.

## Comprobantes (Fase 2)
Un comprobante de pago que coincide en importe exacto y nombre con **una** obligación pendiente del mes (o del anterior) se propone **saldar** (solo para administradores): al confirmar se registra un solo gasto de la casa y se vincula. Si la obligación ya figura pagada → no se crea otro gasto. Una factura sin evidencia de pago sigue pendiente. Nunca se registra solo (siempre pide confirmar).

## Migración (local, NO aplicada en remoto)
`supabase/migrations/20261023120000_control_financiero.sql`: aditiva. Agrega `categories.parent_id` (+ trigger de niveles), `budget_bases`, `fixed_expense_amounts` (con un punto de partida por cada gasto fijo existente: no cambia ningún importe), `admin_actions`, la columna `is_fixed` en la vista `expense_lines` y amplía el CHECK de `whatsapp_messages.outcome`. No borra ni modifica gastos, presupuestos ni obligaciones.

## Guía de despliegue (requiere autorización)
1. Respaldo de la base y aviso al compañero.
2. Aplicar la migración (`npx tsx scripts/migrate.ts`). Corre solo las pendientes. Para la conversación del administrador hay una más, chica y aditiva: `20261024120000_document_hint.sql` (columna `documents.intent_hint`, una etiqueta cerrada).
3. Desplegar `main`. No hay variables nuevas.
4. Verificar: Presupuestos → «Guardar» crea el presupuesto base y aparece en los meses siguientes; Gastos fijos → resumen separado; por WhatsApp (como administrador) probar «Poné $X mensuales de presupuesto para <categoría>» y confirmar.
5. Rollback: redeploy del commit anterior; las tablas nuevas pueden quedar sin uso.

## Límites y decisiones abiertas
- Solo pesos (ARS) en presupuestos y obligaciones, como en la Fase 1.
- Los límites padre/hijo se validan en el mes de vigencia, no en bases futuras distintas.
- Los integrantes **no** pagan ni ven obligaciones (regla de privacidad de la Fase 1).
- Los presupuestos mensuales cargados en la Fase 1 siguen valiendo como excepciones de su mes; para que se renueven solos hay que guardar el presupuesto base.
