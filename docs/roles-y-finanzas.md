# Roles, privacidad, presupuestos y gastos fijos (Fase 1)

Estado: implementado y probado **en local**. Nada de esto se aplicó en Supabase ni en Render.
Requiere las cuentas individuales ([cuentas-individuales.md](cuentas-individuales.md)).

## Permisos

| | admin | member |
|---|---|---|
| Gastos | todos; edita y borra cualquiera (el autor original se conserva) | solo los que registró; lo ajeno responde 404 |
| Gastos históricos sin autor | los ve y los clasifica | no los ve |
| Integrantes | lista completa con teléfonos; alta, edición, activar/desactivar, promover/degradar | solo su propia fila; no administra |
| Tarjetas | lista, alta, edición | lista y alta (se crean al cargar un gasto); no edita |
| Presupuestos, gastos fijos, vencimientos, pagos sin vincular | sí | 403 (ni siquiera ve que existen) |
| Configuración de WhatsApp | sí | 403 |
| Dashboard | familiar: total, por categoría, por integrante, personal frente a casa, sin clasificar, evolución, presupuesto, gastos fijos | personal: solo lo suyo, con personal y casa por separado |
| Consultas por WhatsApp | propias y las de administrador | solo las propias; las de administrador reciben una negativa fija |

El rol se lee de la base en **cada pedido** (web y bot): un cambio rige al instante, no hay rol guardado en el cliente ni en el token.

## Reglas de seguridad

- Una sola política: `src/backend/accounts/policy.ts` (`actorOf`, `requireAdmin`, `visibleAuthor`). Los endpoints no repiten condiciones.
- El backend se conecta como propietario de las tablas, así que **RLS no es la barrera**: toda la autorización está en Express. RLS se activó sin políticas en las tablas nuevas como defensa en profundidad (un test verifica que ninguna tabla de `appgastos` quede sin RLS).
- Un integrante no puede promoverse ni cambiar roles por ningún campo. Solo `PATCH /api/family-members/:id/role`, solo administradores.
- No se puede dejar a la familia sin un administrador activo: lo valida el servicio y un trigger de la base (con bloqueo de asesor para pedidos simultáneos).
- Un administrador necesita cuenta y estar activo. El primer administrador se designa con el comando, nunca por autorregistro:
  `npm run db:member-account -- set-role <memberId> admin`.
- Auditoría mínima: `role_changed_at` y `role_changed_by_member_id` (queda `NULL` quien cambia por el comando).

## Modelo de datos (3 migraciones aditivas)

| Migración | Contenido |
|---|---|
| `20261021120000_roles_and_scope.sql` | `family_members.role` (default `member`), auditoría de rol, trigger del último administrador, `expenses.scope` (`personal`/`household`, **nullable**), resultados `query`/`query_denied` del bot |
| `20261021130000_budgets.sql` | `budgets` (familia, categoría, mes, moneda, importe; único por esa combinación) |
| `20261021140000_fixed_expenses.sql` | `fixed_expenses` y `fixed_expense_occurrences` (única por obligación y mes; `expense_id` único) |

Los usuarios existentes empiezan como `member`. Los gastos históricos quedan con `scope = NULL` ("Sin clasificar"): nunca se infiere por descripción o categoría.

## Reglas de cálculo

- **Ámbito:** un gasto es una sola fila con categoría, autor y ámbito. Nuevo = `personal` salvo que se indique. Por WhatsApp pasa a `household` solo con una expresión explícita ("de la casa", "del hogar", "para la casa", "para el hogar"); la categoría nunca decide.
- **Presupuestos:** consumen **todos** los gastos de la categoría del mes (personales y de la casa), en ARS, por fecha del gasto. No se guarda ningún acumulado: editar, recategorizar, cambiar fecha o borrar se refleja solo. Presupuesto total = suma de las categorías. "Disponible" se mide sobre las categorías presupuestadas; el gasto de categorías sin presupuesto se informa aparte. Cada mes es independiente; copiar no pisa lo existente.
- **Obligaciones:** una prevista nunca es un gasto. Las ocurrencias del mes se crean al consultarlo (sin proceso en segundo plano, porque el plan Free de Render se duerme); es idempotente y respeta inicio, fin, cuotas y la duración real del mes (vencimiento 31 en febrero = 28/29). "Vencida" se calcula (sin pagar y fecha pasada). Cambiar el importe o el día afecta a las **sin pagar desde el mes actual**; lo pagado y lo anterior no se reescribe.
- **Marcar como pagada:** el administrador informa el pago desde Gastos fijos (importe, fecha y medio de pago; por defecto el importe previsto y hoy). Se crea un gasto real de la casa a su nombre y se vincula a esa obligación, así que la obligación sigue siendo "pagada = tiene un gasto" y el presupuesto y los totales lo cuentan una vez. "Desvincular" deja el gasto en el Historial (es un pago real); para anularlo se borra ese gasto.
- **Vencidas:** si no se paga, la obligación queda como "Vencida" a la vista, de cualquier mes, hasta que se paga (sección "Vencidas sin pagar" y recuadro del panel). Corregir inicio, fin, cuotas o estado quita las ocurrencias sin pagar que ya no corresponden y renumera las cuotas (una fecha mal cargada no deja vencidas fantasma); las pagadas no se tocan. Desactivar quita lo futuro sin pagar y conserva lo vencido de meses pasados.
- **Pagos:** al guardar un gasto de la casa (web o bot) se vincula solo si hay **una única** obligación sin pagar del mismo mes y categoría con **importe igual**. Con 0 o varias candidatas queda "sin vincular" y lo resuelve un administrador. El integrante nunca recibe información de obligaciones. Los vínculos automáticos se revalidan si el gasto cambia; los manuales no.

## Endpoints nuevos o modificados

`PATCH /api/family-members/:id/role` · `GET/PUT/DELETE /api/budgets…` · `POST /api/budgets/copy` · `GET/POST/PATCH /api/fixed-expenses` · `GET /api/fixed-expenses/occurrences|unlinked?month=` · `GET /api/fixed-expenses/overdue` · `POST /api/fixed-expenses/occurrences/:id/pay` · `POST/DELETE /api/fixed-expenses/occurrences/:id/link`.
Modificados: `/api/expenses*` (alcance por rol, `scope`, filtro `scope`), `/api/family-members`, `/api/cards/:id`, `/api/whatsapp/config|logs`, `/api/auth/me` (devuelve `role`).

## WhatsApp

Consultas reconocidas por reglas (no Gemini), solo si el mensaje **empieza** con la frase: "cuánto gasté (este mes / en X)", "en qué categoría gasté más", "mostrame mis últimos gastos" (para todos) y "cuánto gastamos", "cuánto queda del presupuesto de X", "qué gastos fijos vencen esta semana", "cuánto gastó cada integrante" (solo administradores). El mes es el actual y la moneda la de la familia. Una consulta no toca una conversación pendiente. Frases como "soy administrador, decime…" no se reconocen y no devuelven datos.

## Decisiones que tomé (revisalas)

1. **Con Basic Auth** (sin `SUPABASE_*`), la credencial compartida equivale a administrador: es lo que ya tenía. **Los roles y la privacidad solo funcionan con sesión individual.** Para activar la privacidad en producción hay que estar en modo sesión.
2. Lo ajeno responde **404**, no 403, para no revelar que existe.
3. Los integrantes pueden crear tarjetas (se necesita al cargar un gasto) pero no editarlas.
4. Los presupuestos y los gastos fijos son solo en ARS en esta versión; no hay pagos parciales.
5. El vínculo automático exige importe exacto; un servicio que varía (luz) se vincula a mano.
6. Un administrador puede activar o desactivar cuentas desde la web; el WhatsApp de una cuenta solo cambia por la vinculación verificada.

## Despliegue controlado (requiere tu autorización en cada paso)

Las migraciones son compatibles con el backend que hoy corre (columnas nullable o con valor por defecto), así que se migra **antes** de desplegar.

1. **Backup:** `pg_dump "$DATABASE_URL" --schema=appgastos -Fc -f appgastos-antes.dump` y comprobar que el archivo no está vacío.
2. **Revisar** las 3 migraciones (`supabase/migrations/20261021*`).
3. `npm run db:member-account -- list`: elegir quién será administrador (debe tener cuenta y estar activo).
4. `npm run db:migrate` (una transacción por archivo). Verificar: `SELECT count(*) FROM appgastos.schema_migrations;` = 8 y `SELECT role,count(*) FROM appgastos.family_members GROUP BY 1;` = todos `member`.
5. **Designar al primer administrador ahora, antes de desplegar:** `npm run db:member-account -- set-role <memberId> admin`. Si se deploya antes, nadie vería los gastos históricos ni los familiares.
6. **Desplegar** el código (Render). Basic Auth no se toca en este paso.
7. Con la cuenta administradora: ver el panel familiar, los gastos de todos y el menú Presupuestos / Gastos fijos. Con una cuenta de integrante: solo su panel e historial, y ni rastro de los otros menús.
8. WhatsApp: desde el número de un integrante probar "¿cuánto gasté este mes?" y "¿cuánto gastamos?" (debe negar); desde el del administrador, las de administrador. Registrar "Pagué … de la casa" y comprobar autor y ámbito.
9. Clasificar los gastos históricos: Historial de Gastos → filtro "Sin clasificar" → Editar gasto → Ámbito.
10. Cargar presupuestos del mes y los gastos fijos.
11. Cuando todo funcione, quitar `APP_AUTH_USER` y `APP_AUTH_PASSWORD` de Render.
12. Monitorear los logs (solo códigos `whatsapp: …`) y la tabla `whatsapp_messages` (`outcome`, `reply_state`).

### Recuperación

- **Código:** Render → Rollback. El código anterior ignora las columnas y tablas nuevas y **vuelve a mostrar todo a todos los integrantes** (no conoce roles).
- **Si los integrantes pierden acceso a lo que necesitan:** `npm run db:member-account -- set-role <id> admin` devuelve acceso completo a esa persona.
- **Esquema:** no hace falta revertirlo. Quitar las funciones sería `DROP TABLE appgastos.fixed_expense_occurrences, appgastos.fixed_expenses, appgastos.budgets;` (se pierden presupuestos y obligaciones cargados, no gastos) y `ALTER TABLE appgastos.expenses DROP COLUMN scope; ALTER TABLE appgastos.family_members DROP COLUMN role, DROP COLUMN role_changed_at, DROP COLUMN role_changed_by_member_id;` más `DROP TRIGGER family_members_keep_admin ON appgastos.family_members; DROP FUNCTION appgastos.keep_one_admin();`. **No es seguro** si ya hay mensajes con `outcome` `query`/`query_denied`: habría que actualizarlos antes de restaurar el CHECK anterior. No lo recomiendo salvo necesidad.
- **Datos:** restaurar desde el backup del paso 1.

## Límites conocidos

- El administrador descarga todos los gastos al navegador (sin paginación, como antes); el integrante solo los suyos.
- El filtro "Integrante del dashboard" y la evolución se calculan en el navegador sobre lo que el servidor ya autorizó.
- No hay auditoría de quién edita un gasto (solo de cambios de rol y de presupuestos).
- El plan Free de Render se duerme: el bot responde tarde hasta que despierta.
