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
Ejemplos: «Creá la subcategoría Verdulería dentro de Alimentación», «Poné $500.000 mensuales de presupuesto para Alimentación», «Agregá el colegio como gasto fijo de $180.000, vence el día 10» (pregunta la categoría si falta), «Desde diciembre el colegio cuesta $200.000», «Ya pagué el colegio de noviembre» (identifica la obligación; pregunta el medio de pago; ambigüedad → pregunta el mes; ya pagada → no registra nada).
Consultas deterministas: «¿Cuánto tengo pendiente de gastos fijos?», «¿Cuánto me queda del presupuesto de comida?».
- Rol e identidad salen del número vinculado. Un integrante que pide configurar recibe «solo para administradores» sin llamar a Gemini.
- Idempotente: confirmar dos veces (o reprocesar el mensaje) no aplica dos veces; un pedido nuevo reemplaza al pendiente; un error de negocio al confirmar no deja nada a medias.
- Gemini nunca ejecuta SQL ni decide permisos.

## Comprobantes (Fase 2)
Un comprobante de pago que coincide en importe exacto y nombre con **una** obligación pendiente del mes (o del anterior) se propone **saldar** (solo para administradores): al confirmar se registra un solo gasto de la casa y se vincula. Si la obligación ya figura pagada → no se crea otro gasto. Una factura sin evidencia de pago sigue pendiente. Nunca se registra solo (siempre pide confirmar).

## Migración (local, NO aplicada en remoto)
`supabase/migrations/20261023120000_control_financiero.sql`: aditiva. Agrega `categories.parent_id` (+ trigger de niveles), `budget_bases`, `fixed_expense_amounts` (con un punto de partida por cada gasto fijo existente: no cambia ningún importe), `admin_actions`, la columna `is_fixed` en la vista `expense_lines` y amplía el CHECK de `whatsapp_messages.outcome`. No borra ni modifica gastos, presupuestos ni obligaciones.

## Guía de despliegue (requiere autorización)
1. Respaldo de la base y aviso al compañero.
2. Aplicar la migración (`npx tsx scripts/migrate.ts`). Ya hay una migración previa de la Fase 2 (`20261022120000_documents.sql`): si ya está aplicada, solo corre la nueva.
3. Desplegar `main`. No hay variables nuevas.
4. Verificar: Presupuestos → «Guardar» crea el presupuesto base y aparece en los meses siguientes; Gastos fijos → resumen separado; por WhatsApp (como administrador) probar «Poné $X mensuales de presupuesto para <categoría>» y confirmar.
5. Rollback: redeploy del commit anterior; las tablas nuevas pueden quedar sin uso.

## Límites y decisiones abiertas
- Solo pesos (ARS) en presupuestos y obligaciones, como en la Fase 1.
- Los límites padre/hijo se validan en el mes de vigencia, no en bases futuras distintas.
- Los integrantes **no** pagan ni ven obligaciones (regla de privacidad de la Fase 1).
- Los presupuestos mensuales cargados en la Fase 1 siguen valiendo como excepciones de su mes; para que se renueven solos hay que guardar el presupuesto base.
