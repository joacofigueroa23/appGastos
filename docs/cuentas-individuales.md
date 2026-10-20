# Cuentas individuales y autoría de gastos

> Fase siguiente (roles, privacidad por integrante, presupuestos y gastos fijos): [roles-y-finanzas.md](roles-y-finanzas.md). Cambia lo que ve cada integrante: lo descrito abajo sobre lectura familiar abierta pasa a ser solo del administrador.

Estado: implementado y probado en local. **Nada de esto se aplicó en Supabase ni en Render.**

## Cómo funciona

- **Identidad:** Supabase Auth (email y contraseña). El backend valida cada token llamando a `GET {SUPABASE_URL}/auth/v1/user`; Supabase comprueba firma, vencimiento y revocación. La anon key sola nunca identifica a nadie. Una respuesta válida se guarda 30 s en memoria.
- **Pertenencia:** una cuenta entra solo si existe un integrante activo con `family_members.auth_user_id = <id de la cuenta>` en la familia del servidor (`APP_FAMILY_ID`). La familia nunca la elige el cliente. Cuenta sin integrante o integrante inactivo → 403, con el mismo mensaje.
- **Autoría:** sigue siendo `expenses.reported_by_member_id` (no hay columna nueva). Con sesión individual:
  - al crear, el servidor la fija con el integrante de la sesión;
  - un valor distinto enviado por el cliente se rechaza (403);
  - al editar se conserva el autor original; intentar cambiarlo da 403;
  - los gastos históricos siguen en `NULL` y la web los muestra como "Sin autor identificado". No se les asigna autor.
- **WhatsApp:** el bot ya identificaba al integrante por `phone_number`. Ahora ese número se vincula de forma verificada:
  1. el integrante abre **Mi perfil → Vincular WhatsApp** y recibe un código (8 caracteres, vence en 10 min, un solo uso, solo se guarda su hash);
  2. envía `VINCULAR ABCD-2345` al bot **desde el número que quiere vincular**;
  3. el bot completa la vinculación en la misma transacción que registra el mensaje.
  Un número ya usado por otro integrante activo no se puede vincular (índice único + control explícito). 5 intentos fallidos por remitente y por hora bloquean ese remitente. Un número no vinculado recibe una respuesta que explica cómo vincularse y no registra nada.
- **Edición y eliminación:** igual que antes: cualquier integrante activo puede editar o borrar gastos de la familia (son compartidos). Se conserva el autor original. No existe tabla de auditoría de cambios, por lo que no se registra quién editó.
- **Quién administra cuentas:** no hay rol de administrador en la web. Habilitar, retirar o desactivar el acceso de una cuenta lo hace quien tiene acceso a la base con `npm run db:member-account`. Desde la API, un integrante con cuenta no puede cambiar el WhatsApp ni el estado activo de otro, ni el propio.
- **Basic Auth:** sigue siendo el modo por defecto. Si `SUPABASE_URL` y `SUPABASE_ANON_KEY` **no** están definidas, todo funciona como hoy. Si están definidas, Basic Auth deja de aplicarse (la web se sirve sin clave y `/api` exige sesión). Nunca rigen los dos a la vez. El webhook de Meta conserva su firma en ambos modos.
- **RLS:** el backend usa una conexión directa como propietario de las tablas y no pasa por la Data API de Supabase, por lo que RLS no es la barrera de acceso. La migración activa RLS sin políticas en todas las tablas de `appgastos` como defensa en profundidad: si el esquema se expusiera por error en la Data API, los roles `anon` y `authenticated` no leerían nada. El esquema `appgastos` no debe estar en "Exposed schemas".

## Variables nuevas

| Variable | Dónde | Valor |
|---|---|---|
| `SUPABASE_URL` | servidor | URL del proyecto (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | servidor | clave **anon / publishable** (pública por diseño). Nunca `service_role`. |

Se definen juntas o ninguna. `APP_AUTH_USER` y `APP_AUTH_PASSWORD` se ignoran cuando hay Supabase; en producción el servidor exige una de las dos opciones para arrancar.

## Configuración en Supabase (pendiente, manual)

1. Authentication → Sign In / Providers → Email habilitado; **desactivar "Allow new users to sign up"** (no hay registro público).
2. Authentication → Users → **Add user → Create new user** con email y contraseña (marcar auto-confirm). Copiar el **User UID**.
3. Authentication → URL Configuration: *Site URL* = URL pública de Render. La app no usa enlaces de correo (invitación o recuperación): no hay pantalla de restablecimiento de contraseña. Si alguien la olvida, se cambia desde el panel de Supabase.

## Alta de un integrante con cuenta

1. En la web actual, pestaña **Tarjetas e integrantes**, crear el integrante (nombre; el teléfono se puede dejar vacío).
2. `npm run db:member-account -- list` muestra los ids.
3. `npm run db:member-account -- link <memberId> <userUid>`.
4. El integrante inicia sesión y vincula su WhatsApp en **Mi perfil**.

Otros comandos: `unlink`, `deactivate`, `activate`. Usan `DATABASE_URL` y `APP_FAMILY_ID` del `.env`.

## Plan de puesta en producción (requiere tu autorización en cada paso)

Las migraciones son aditivas y compatibles con el backend que hoy corre: se puede migrar **antes** de desplegar.

1. **Backup:** `pg_dump "$DATABASE_URL" --schema=appgastos -Fc -f appgastos-antes.dump`.
2. **Pre-chequeo** de números duplicados (el índice único nuevo falla si ya hay dos integrantes activos con el mismo teléfono):
   ```sql
   SELECT family_id, regexp_replace(phone_number,'[\s()+\-]','','g') AS telefono, count(*)
   FROM appgastos.family_members WHERE active AND phone_number IS NOT NULL
   GROUP BY 1,2 HAVING count(*)>1;
   ```
   Debe devolver 0 filas. Si devuelve alguna, el bot ya respondía "no autorizado" a ese número: corregirlo antes.
3. `npm run db:migrate` (aplica `20261020120000_member_accounts.sql` en una transacción; si falla, no queda nada a medias).
4. Verificar: `SELECT name FROM appgastos.schema_migrations ORDER BY name;` lista 5 filas y `\d appgastos.family_members` muestra `auth_user_id`.
5. **Desplegar el código nuevo sin variables de Supabase.** Sigue en Basic Auth: comprobar web y bot como siempre.
6. Configurar Supabase (sección anterior) y dar de alta a los integrantes (`link`).
7. En Render agregar `SUPABASE_URL` y `SUPABASE_ANON_KEY` → redeploy. Comprobar: login de cada integrante, gasto desde la web con autor, vinculación de WhatsApp, gasto por el bot con autor, número desconocido rechazado.
8. Cuando todo funcione, quitar `APP_AUTH_USER` y `APP_AUTH_PASSWORD` de Render.
9. Monitorear los logs de Render (solo códigos `whatsapp: ...`, sin números ni textos).

## Rollback

- **Configuración:** borrar `SUPABASE_URL` y `SUPABASE_ANON_KEY` en Render vuelve a Basic Auth (requiere que `APP_AUTH_*` sigan cargadas: por eso el paso 8 es el último).
- **Código:** Render → Deploys → Rollback. El código anterior ignora las columnas y tablas nuevas.
- **Esquema:** no hace falta revertirlo, es aditivo. Si se quisiera: `DROP TABLE appgastos.whatsapp_link_codes; ALTER TABLE appgastos.family_members DROP COLUMN auth_user_id;` y borrar el índice `family_members_active_phone_uidx` pierde solo los vínculos de cuenta (se rehacen con `link`), no gastos. Los valores `linked` y `link_failed` de `outcome` quedarían en mensajes viejos: antes de restaurar el CHECK anterior habría que actualizarlos. No lo recomiendo salvo necesidad.
- **Datos:** restaurar desde el backup del paso 1.

## Límites conocidos

- Una sesión revocada en Supabase puede seguir valiendo hasta 30 s en este servidor.
- Un integrante con cuenta puede editar y borrar gastos ajenos (decisión: son compartidos).
- No hay auditoría de quién editó un gasto.
- No hay recuperación de contraseña dentro de la app.
- La búsqueda de integrante en el dashboard filtra en el navegador sobre todos los gastos cargados (sin paginación, como el resto).
