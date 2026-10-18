# Deploy en Render: preparación y plan (NO ejecutado)

Nada de esto se aplicó. Cada paso marcado con ⚠ requiere autorización explícita.

> Cuentas individuales (login por integrante, autoría y vinculación de WhatsApp): ver [cuentas-individuales.md](cuentas-individuales.md). Es una fase posterior y no cambia nada de este documento hasta que se definan `SUPABASE_URL` y `SUPABASE_ANON_KEY`.

## 1. Servicio web

| Campo | Valor | Verificado |
|---|---|---|
| Build Command | `npm ci --include=dev && npm run build` | Sí, local: `npm run build` OK. `tsx` y `vite` están en devDependencies, por eso `--include=dev`. |
| Start Command | `npm start` (ejecuta `tsx server.ts --production`) | Sí, local: sirve `dist/`, exige Basic Auth, sin credenciales no arranca. |
| Puerto | Render define `PORT`; el servidor lo lee | Sí (`server.ts`). No definirlo a mano. |
| Health check | No existe ruta propia. `/` y `/api/*` devuelven 401 sin credenciales | Dejar el campo vacío (Render comprueba el puerto). Una ruta pública nueva es decisión tuya. |
| Plan | Uno que no se suspenda (pago). El gratuito se duerme tras 15 min | Ver riesgos. |

## 2. Variables de entorno

| Variable | Función | Oblig. | Momento | Dónde obtenerla | Estado |
|---|---|---|---|---|---|
| NODE_ENV | Modo producción | Sí | build y runtime | `production` | `npm start` ya lo fuerza; igual conviene definirla |
| DATABASE_URL | Conexión PostgreSQL | Sí | runtime | Supabase → Connect. La actual apunta al pooler en modo sesión (puerto 5432, compatible con IPv4) | Formato verificado local; remoto NO verificado |
| DATABASE_CA_FILE | Certificado raíz TLS | Recomendada | runtime | Valor `prod-ca-2021.crt` (ruta relativa; el archivo está versionado en la raíz) | Archivo presente |
| APP_FAMILY_ID | Familia única | Sí | runtime | Igual al `id` de `appgastos.families` en Supabase | No verificado en remoto |
| APP_AUTH_USER / APP_AUTH_PASSWORD | Basic Auth | Sí (sin ellas no arranca) | runtime | Las elegís vos, clave larga | Comportamiento verificado local |
| GEMINI_API_KEY | Interpretación | Sí para el bot | runtime | Google AI Studio | Solo backend; no aparece en `dist/` |
| GEMINI_MODEL | Lista de modelos | No | runtime | Ver `.env.example` | — |
| WHATSAPP_APP_SECRET | Firma del webhook | Sí | runtime | Meta → App → Configuración básica | No verificado |
| WHATSAPP_VERIFY_TOKEN | Verificación del webhook | Sí | runtime | Lo inventás vos; igual en Meta | — |
| WHATSAPP_ACCESS_TOKEN | Enviar respuestas | Sí | runtime | Token **permanente** de System User | No verificado (el temporal vence a las 24 h) |
| WHATSAPP_PHONE_NUMBER_ID | Número de Cloud API | Sí | runtime | Meta → WhatsApp → API Setup | No verificado |
| APP_URL | URL pública | Informativa (la usa `/api/whatsapp/config`) | runtime | URL de Render | Pendiente |
| APP_TIME_ZONE, WHATSAPP_GRAPH_VERSION, WHATSAPP_CONVERSATION_TTL_MINUTES | Ajustes | No | runtime | Ver `docs/whatsapp.md` | — |

**No definir en Render:** `VITE_ENABLE_DEMO` (en el build volvería demo la interfaz), `FRONTEND_DIST_DIR`, `SEED_*`, `WHATSAPP_BUSINESS_ACCOUNT_ID` (solo lo usa el demo), `PORT`, cualquier `VITE_*` con secretos.

Seguridad verificada: ninguna variable de `.env` ni los nombres `GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `DATABASE_URL` o `APP_AUTH` aparecen en el bundle de `dist/`. Los secretos se cargan en Render (Environment → Secret), nunca en archivos versionados.

## 3. Base de datos ⚠ (no ejecutado, estado remoto no verificado)

Migraciones, en orden alfabético (las aplica `npm run db:migrate`, una transacción por archivo, con bloqueo asesor y checksum):
1. `20261008230119_appgastos_core.sql`: esquema `appgastos`, familias, integrantes, categorías, tarjetas, gastos, índices, trigger.
2. `20261011213315_whatsapp_text_inbox.sql`: cola de mensajes (con RLS activado).
3. `20261014120000_card_type.sql`: columna `card_type` en tarjetas.
4. `20261016120000_whatsapp_conversations.sql`: conversaciones, columnas nuevas en mensajes, reemplaza el CHECK de `outcome` (DROP + ADD en la misma transacción).

Riesgos: ninguna migración borra tablas ni datos. El único `DROP` es la restricción `whatsapp_messages_outcome_check`, recreada ampliada en la misma transacción. Sirven sobre base vacía y no requieren extensiones. `gen_random_uuid()` es nativo. Si una migración ya aplicada cambió de contenido, `migrate` aborta.

Seed (`npm run db:seed`): idempotente (`ON CONFLICT DO NOTHING`). Crea la familia con id `APP_FAMILY_ID` (o `00000000-0000-4000-8000-000000000001` si no está definida) y las categorías del catálogo. Con `SEED_MEMBER_NAME` crea un integrante. No crea tarjetas ni gastos.

**Dato mínimo para que el bot responda:** al menos un integrante activo con `phone_number` cargado (desde la pestaña de gestión familiar de la web, campo "Teléfono del integrante"). Sin eso, todo mensaje recibe "no autorizado".

Procedimiento propuesto (desde tu PC, con el `DATABASE_URL` de producción; el modo sesión del pooler admite el bloqueo asesor):
1. Backup: `pg_dump "$DATABASE_URL" --schema=appgastos -Fc -f appgastos-antes.dump` (o backup desde el panel de Supabase). Si el esquema `appgastos` aún no existe, el dump saldrá vacío o fallará: es normal.
2. Confirmar que `APP_FAMILY_ID` local es el que usará Render.
3. `npm run db:migrate` y luego `npm run db:seed` (con `SEED_MEMBER_NAME` si querés crear tu integrante).
4. Verificar: `SELECT name FROM appgastos.schema_migrations ORDER BY name;` debe listar 4 filas. `SELECT id,name FROM appgastos.families;` debe devolver el `APP_FAMILY_ID`. `SELECT count(*) FROM appgastos.categories;` > 0.
5. Recuperación: restaurar con `pg_restore` desde el dump. Si el esquema es nuevo, `DROP SCHEMA appgastos CASCADE` (⚠ destructivo, solo con tu autorización y solo si estaba vacío).

Nota: el esquema `appgastos` no debe exponerse en la API de datos de Supabase (Settings → API → Exposed schemas).

## 4. Meta WhatsApp ⚠ (no ejecutado)

Ruta verificada en el código: `GET/POST /api/whatsapp/webhook` (`src/backend/whatsapp/routes.ts`), exenta de Basic Auth, firma `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`, devuelve 200 solo después de guardar en PostgreSQL (503 si no pudo, para que Meta reintente), duplicados ignorados por `message_id`.

Pasos, después de que Render esté arriba con las variables cargadas:
1. Anotar la URL HTTPS definitiva y completar `APP_URL`.
2. Meta → WhatsApp → Configuration → Callback URL `https://<dominio>/api/whatsapp/webhook`, Verify token = `WHATSAPP_VERIFY_TOKEN`. "Verify and save" debe dar éxito (el servidor responde el desafío).
3. Suscribir el campo `messages`.
4. Confirmar que el token es de System User, permanente, con permiso `whatsapp_business_messaging`, y que `WHATSAPP_PHONE_NUMBER_ID` es el del número (no el WABA ID).
5. En modo desarrollo de Meta, el teléfono de la familia debe estar en la lista de destinatarios de prueba.
6. Enviar "Gasté 1000 en kiosco con efectivo". Esperado: respuesta ✅ del bot, una fila en `appgastos.expenses` con `source='whatsapp'` y una en `whatsapp_messages` en `completed`.
7. Reenviar desde Meta el mismo evento (o revisar reintentos): no debe duplicarse el gasto.
8. Revisar logs de Render: solo aparecen códigos (`whatsapp: ...`), sin números ni textos.

## 5. Rollback

- Código: en Render → Deploys → "Rollback" al deploy anterior (o redeploy del commit anterior). El esquema no se revierte solo: las migraciones son aditivas, por lo que el código anterior sigue funcionando.
- WhatsApp: pausar la suscripción `messages` en Meta o quitar el callback; los mensajes ya guardados quedan en la cola.
- Datos: restaurar desde el backup del paso 3.1.
