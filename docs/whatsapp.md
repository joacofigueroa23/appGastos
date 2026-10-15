
# WhatsApp por texto: configuración y operación

Un gasto por texto, en un mensaje completo o completado a lo largo de varios mensajes
(ver "Conversación"). No admite imágenes, audio, tickets, consultas financieras,
creación de catálogos por WhatsApp ni varios gastos pendientes por integrante.
El código y las pantallas anteriores se conservan en modo demo explícito.

## Flujo

Webhook POST con firma válida → recepción durable en PostgreSQL (con el timestamp de Meta)
→ worker en orden por remitente → identificación del miembro → conversación activa
→ reglas deterministas o Gemini → validación del parche (evidencia del mensaje)
→ actualización del borrador → validación del borrador → UNA pregunta, o
createExpense con source=whatsapp → COMMIT → respuesta por Meta.

El webhook devuelve 200 únicamente después de guardar los mensajes en PostgreSQL.
Una recepción que no se pudo guardar devuelve 503 para que Meta pueda reintentar.
200 confirma recepción técnica, no registro financiero.

El worker de Express revisa pendientes cada 2 segundos y recupera tareas con lease vencida.
El texto original se elimina de la fila al completar el procesamiento; el borrador guarda solo
los fragmentos que respaldan cada dato ("35 mil", "Carrefour").
Los logs solo muestran códigos técnicos, sin números, texto, credenciales ni candidatos.

## Variables del servidor

Completar el .env **local del proyecto interior**, junto a package.json.
No escribir secretos en archivos versionados, frontend, ejemplos, migraciones ni tests.

Variables obligatorias para la conexión real:
- DATABASE_URL y APP_FAMILY_ID: configuración actual de PostgreSQL, sin cambios.
- GEMINI_API_KEY: clave actual, utilizada únicamente en backend.
- WHATSAPP_APP_SECRET: secreto de la aplicación de Meta que firma los webhooks.
- WHATSAPP_VERIFY_TOKEN: valor privado elegido por vos, igual al configurado en Meta.
- WHATSAPP_ACCESS_TOKEN: token autorizado a enviar mensajes desde el número empresarial.
- WHATSAPP_PHONE_NUMBER_ID: ID del número en Cloud API; no es el teléfono ni el Business Account ID.
- APP_URL: URL pública HTTPS que llega al webhook Express.

Opcionales:
- APP_TIME_ZONE: America/Argentina/Buenos_Aires por defecto.
- GEMINI_MODEL: lista separada por comas; ante sobrecarga (503/429/timeout) se prueba el siguiente. Por defecto gemini-3.5-flash-lite,gemini-3.1-flash-lite.
  Configurar un único modelo desactiva el respaldo: usar al menos dos (ver .env.example).
- WHATSAPP_GRAPH_VERSION: v21.0 por defecto; usar una versión habilitada en tu aplicación.
- WHATSAPP_CONVERSATION_TTL_MINUTES: minutos sin mensajes válidos tras los cuales vence una
  conversación pendiente. Entero de 1 a 1440; ausente o inválido → 30. Se lee solo en
  src/backend/whatsapp/config.ts.

## Conversación (varios mensajes, un gasto)

```
Usuario: Compré en Carrefour
Bot:     ¿Cuánto gastaste?
Usuario: 35 mil
Bot:     ¿Cómo pagaste? Efectivo, débito, crédito, transferencia o billetera virtual.
Usuario: crédito
Bot:     ¿Con qué tarjeta? 1) Visa  2) Mastercard  3) Ninguna
Usuario: Visa
Bot:     ✅ Registrado: $35.000 en Carrefour · Supermercado · Visa.
```

Modelo: appgastos.whatsapp_conversations guarda sesión y borrador (draft JSONB) en una fila.
Estados: active, confirmed (con expense_id), cancelled, expired, error. Un índice único parcial
permite una sola conversación activa por integrante. Cada mensaje guarda su conversation_id.
Nada se borra: las conversaciones cerradas quedan como auditoría.

- Un mensaje completo se registra directo, sin crear conversación.
- Si falta algo, se crea la conversación y se pregunta UN campo, en este orden:
  monto → medio de pago → tarjeta → categoría (→ fecha, solo si se indicó una fecha no válida).
- Tarjeta: se pregunta si el medio es crédito/débito y hay tarjetas activas de ese tipo o sin
  tipo. "Ninguna" o el número de la lista son respuestas válidas. Si el nombre coincide con varias
  tarjetas, decide el tipo (crédito/débito); si siguen varias, se pregunta. Nunca la primera.
- Categoría: siempre obligatoria; se ofrece la lista numerada de categorías activas.
- Descripción: nunca se pregunta; si falta, "Compra en {comercio}" o "Gasto en {categoría}".
- Fecha: la del primer mensaje en APP_TIME_ZONE, salvo fecha explícita.
- Moneda: la de la familia salvo moneda explícita. Respuesta con $35.000 o US$ 100.
- Respuestas cortas (monto, medio, tarjeta, categoría, número de lista, fecha) se resuelven sin
  Gemini. Si no alcanza, Gemini recibe el borrador con nombres reales y el campo preguntado.
- Cada dato nuevo se valida contra la evidencia del mensaje que lo aporta; el borrador completo se
  vuelve a validar contra las reglas del gasto y los catálogos activos antes de registrar.
- Correcciones: un dato ya cargado solo cambia con una frase de corrección ("perdón",
  "me equivoqué", "en realidad", "corrijo", "no fue X, fue Y"). Sin esa frase, un dato cargado se
  ignora; dos o más datos cargados distintos son otro gasto: se informa el pendiente y no se mezcla.
- Corrección de un gasto YA registrado: si no hay conversación abierta, el mensaje tiene frase de
  corrección y el último gasto que ese integrante registró por WhatsApp es de hace menos del TTL
  (30 min por defecto), se corrige ESE gasto con el servicio central (nunca se crea otro). Responde
  "✏️ Corregido: …". "Perdón, fue con tarjeta" sin crédito/débito vuelve a preguntar el medio y la
  tarjeta. Gastos anteriores al último, de otro integrante, borrados o fuera de la ventana no se tocan.
  "cancelar" durante la corrección deja el gasto como estaba.
- Cancelación: el mensaje empieza con cancelar, cancelá, no lo cargues, olvidalo, dejalo.
- Tres respuestas incomprensibles seguidas cancelan la conversación con aviso.
- Vencimiento: se evalúa con la hora del siguiente mensaje; la conversación queda expired y ese
  mensaje se procesa como interacción nueva. No se avisa proactivamente.
- Orden: los mensajes de un remitente se procesan en serie según el timestamp de Meta.
  Una versión en la conversación evita aplicar un parche calculado sobre un borrador viejo.
- Gemini caído: el borrador no cambia. Error pasajero → reintento en cola; definitivo → aviso y
  se repite la pregunta pendiente.
- Billeteras (Mercado Pago, MP, QR, Brubank, billetera) se registran como "billetera virtual"
  sin identificar cuál. La lista está en WALLET_NAMES (candidate.ts).

No hay una API web que permita cambiar credenciales reales. GET /api/whatsapp/config
solo devuelve indicadores de presencia e ID enmascarado; nunca devuelve el verify token.
POST /api/whatsapp/config responde 403 en modo normal.
Tras cambiar .env, reiniciar Express.

## Token permanente (que no venza)

El token de la página "API Setup" de Meta es temporal: vence a las 24 h y las respuestas
dejan de salir (error 190, last_error reply_failed:meta_token_expired). Al arrancar, Express
consulta el estado del token y avisa en consola si está vencido, por vencer o es temporal.

Generar un token de System User sin vencimiento:
1. business.facebook.com → Configuración del negocio → Usuarios → Usuarios del sistema → Agregar.
   Nombre a elección, rol Administrador.
2. En ese usuario: Asignar activos → Apps → tu app → Control total.
   Luego Cuentas de WhatsApp → la cuenta del número → Control total.
3. Generar token → elegir la app → Vencimiento: **Nunca** → permisos
   whatsapp_business_messaging y whatsapp_business_management → Generar. Copiarlo una vez.
4. Reemplazar WHATSAPP_ACCESS_TOKEN en .env y reiniciar Express. No debe aparecer el aviso
   meta_token_*. Si el token se filtra, revocarlo desde el mismo usuario del sistema.

## Migración mínima

20261016120000_whatsapp_conversations.sql (capa conversacional) crea
appgastos.whatsapp_conversations (privada, RLS sin políticas) y agrega a whatsapp_messages
conversation_id, meta_timestamp y los resultados nuevos del CHECK de outcome
(question, corrected, cancelled, pending_conflict, nothing_to_cancel, unrecognized).
No modifica filas existentes: los mensajes históricos quedan con meta_timestamp NULL.

20261011213315_whatsapp_text_inbox.sql crea appgastos.whatsapp_messages:
ID único de mensaje, familia, remitente, texto pendiente, tipo, recepción,
estado/lease/reintentos, referencia opcional al gasto, resultado y respuesta pendiente.

La tabla permanece privada, con RLS habilitado y sin políticas de acceso web.
El rol de conexión del backend debe tener los permisos necesarios; la configuración
actual usa el propietario. No se expone mediante la Data API.
No cambia tablas existentes ni borra datos. El runner actual lleva el checksum.
No modificar migraciones ya aplicadas.

El gasto y la finalización del mensaje se confirman dentro de **la misma transacción**.
createExpense conserva validación y referencias; recibe la conexión de esa transacción.
No hay INSERT de gastos paralelo dentro del módulo WhatsApp.

El ID de mensaje no desaparece si el usuario elimina posteriormente el gasto:
la referencia se vuelve null y el estado sigue completado. Reenviar ese evento no recrea el gasto.
No limpiar los IDs procesados sin definir antes una política que preserve idempotencia.

Las respuestas tienen su propio estado persistente y hasta cinco intentos de envío.
Un envío fallido no vuelve a crear el gasto. Si Meta acepta una respuesta y se corta
la conexión antes de poder confirmar su entrega, podría repetirse la respuesta; el gasto no.
Los mensajes con error de PostgreSQL quedan pendientes para reintentar sin confirmar registro.

## Interpretación y validación

El modelo devuelve campos nullable y evidencia textual de monto, medio, fecha y moneda.
El miembro nunca proviene del modelo. No se usa confidence como autorización.

Obligatorios: monto positivo con máximo dos decimales, fecha válida, moneda real,
descripción, categoría activa y medio de pago. Este último es NOT NULL en el esquema actual.
Comercio y tarjeta son opcionales; si están informados se comprueban.
No se elige medio de pago ni tarjeta por defecto.

Solo se consulta la familia configurada. Para el teléfono se quitan exclusivamente
+, espacios, guiones y paréntesis, preservando los dígitos.
No se agrega 54, 9 ni ningún prefijo nacional. Un número local no se convierte automáticamente
en internacional. Cero o varias coincidencias de integrantes activos implica rechazo.
No se crean ni se modifican integrantes automáticamente.

Gemini recibe únicamente los nombres activos de categorías/tarjetas de PostgreSQL.
El backend resuelve categorías por nombre normalizado exacto y exige una sola coincidencia.
Para tarjetas exige una coincidencia inequívoca del nombre informado; referencias parciales
que coinciden con varios nombres se rechazan. Nunca elige la primera.
El servicio de gastos vuelve a verificar actividad y pertenencia durante la transacción.

Gemini nunca decide crédito/débito a partir del nombre de la tarjeta. Si la tarjeta resuelta
tiene tipo configurado (cards.card_type), el backend usa ese tipo como medio de pago; si el
mensaje indica otro medio, se rechaza. Con tipo sin definir, la tarjeta exige crédito o débito
explícito en el mensaje. Un mensaje sin medio de pago resoluble no se guarda.
Tarjetas inexistentes, inactivas o ambiguas no se convierten silenciosamente en null.
Los montos se conservan como strings decimales hasta NUMERIC; 1234.56 nunca se convierte en 123456.
La evidencia numérica no puede recortar un decimal del mensaje para cambiar su valor.

Fecha sin mención: día de recepción en APP_TIME_ZONE, calculado por el backend.
Fecha sin año: año del día de recepción. Formatos soportados: YYYY-MM-DD, DD/MM,
DD/MM/YYYY, día de mes en español, hoy, ayer, anteayer y mañana.
Fechas no resolubles o inválidas requieren otro mensaje completo; no se reemplazan por hoy.
Moneda ausente: families.default_currency. Moneda explícita: código válido o alias reconocido.
No depende de que Gemini complete defaults. Si el texto contiene fechas o monedas
explícitas contradictorias, se rechaza aunque el modelo seleccione solamente una.

Expresiones coloquiales aceptadas:
- Montos: "15 mil", "15k", "2 lucas", "1,5 mil" (multiplican por mil, con evidencia literal).
- Moneda: "pesos" sin otra nacionalidad es ARS; "$" es la moneda de la familia; "u$s" es USD explícito.
- Medio: "transferí"/"transferido" es transferencia. Mercado Pago, MP, QR y billetera son
  billetera virtual (wallet), nunca tarjeta. Una tarjeta llamada "mercado pago" debe desactivarse.
- Si el texto no contiene ninguna palabra de pago, un medio propuesto por el modelo se descarta
  (no se usa) y decide el tipo configurado de la tarjeta; si no hay, falta el medio de pago.

Diagnóstico: last_error guarda solo códigos técnicos, por ejemplo
interpretation_failed:http_404, interpretation_transient:http_503 o interpretation_invalid_output:schema.

Si falta información, la respuesta enumera faltantes/errores y no crea el gasto.
Si Gemini falta, falla o devuelve una salida incompatible, se responde error controlado.
No hay extracción ficticia ni éxito simulado.

## Pasos para probar tu aplicación Meta existente

1. Desde una terminal, entrar al **proyecto interior**:
   cd appGastos
   Si ya estás en la carpeta que contiene server.ts, src y los scripts db:migrate, no repetir cd.
2. Completar en .env las cuatro variables WHATSAPP_ indicadas arriba desde tu aplicación Meta.
   GEMINI_API_KEY ya existe localmente; revisar que el modelo esté disponible.
   No compartir estos valores por chat. WHATSAPP_APP_SECRET es el App Secret, no el access token.
3. Aplicar la migración una vez:
   npm run db:migrate
   No ejecutar seed para crear integrantes o tarjetas de prueba productivos.
4. Detener la instancia anterior con Ctrl+C y arrancar:
   npm run dev
   Abrir http://localhost:3000 y comprobar que la carga manual sigue disponible.
5. En Tarjetas e integrantes, editar o crear **explícitamente** el integrante real.
   Guardar su teléfono internacional con los mismos dígitos que WhatsApp envía en from.
   Mantenerlo activo. Comprobar que no haya otro integrante activo con ese número.
   Para probar Visa, crear/activar explícitamente esa tarjeta y, si corresponde, elegir su tipo.
6. Disponer de una URL pública HTTPS que enrute hacia Express y establecer APP_URL.
   Publicar externamente solamente /api/whatsapp/webhook mediante el proxy/ruta del servidor:
   la autenticación web general sigue fuera de esta etapa y las APIs manuales no deben
   exponerse junto al webhook sin protección. No usar vite preview para la API.
7. En la configuración de Webhooks de la aplicación Meta existente, poner:
   Callback URL: APP_URL seguido de /api/whatsapp/webhook.
   Verify token: el mismo valor de WHATSAPP_VERIFY_TOKEN.
   Verificar y suscribir los eventos messages de WhatsApp.
   Comprobar que el número empresarial corresponde a WHATSAPP_PHONE_NUMBER_ID.
8. Si utilizás el número de prueba de Meta, agregar/verificar el teléfono del integrante
   como destinatario permitido. Revisar vigencia del access token y permisos de WhatsApp.
9. Desde ese teléfono enviar un mensaje nuevo:
   Gasté 35000 en Carrefour con Visa crédito
   Esperar confirmación. Se guarda source=whatsapp y el informante identificado.
   Historial y Dashboard se actualizan dentro de aproximadamente 10 segundos con la página
   visible; elegir el mes de la recepción y la moneda correcta. Al volver a la ventana
   también se actualizan los gastos.
10. Conversación: enviar "Compré en Carrefour" y responder de a una pregunta
    (35 mil → crédito → Visa). Se crea UN gasto al final; antes no se registra nada.
    Probar también "Perdón, fueron 38 mil" en medio de la conversación y "cancelar".
    Enviar una imagen/audio: solo responde que se admiten textos.
11. Desde un número no autorizado: debe rechazar el registro sin llamar Gemini.
12. Para repetir el mismo ID y forzar caídas/errores, usar los tests aislados;
    no recrear mensajes ni borrar registros productivos para probar idempotencia.

Si el texto solo dice Visa y la tarjeta tiene tipo sin definir, el rechazo es correcto.
Con tipo configurado como crédito, "Gasté 35000 en Carrefour con Visa" se registra como crédito.

## Verificación automática

npm run lint
npm test
npm run build
npm run test:browser
npm run test:legacy-browser

Las pruebas crean PostgreSQL y perfiles Chrome temporales. No usan DATABASE_URL productiva
para crear/borrar gastos. La interpretación y el envío de las pruebas están inyectados:
no llaman a Gemini ni envían mensajes reales. Las pruebas verifican firma real HMAC,
recepción HTTP, persistencia SQL, fallos reales de INSERT, referencias, duplicados,
leases/reinicio, envío posterior al COMMIT, rechazo de media y actualización del navegador.

El funcionamiento con las credenciales y el número real de Meta requiere la prueba
de aceptación anterior; no se simula su realización.
