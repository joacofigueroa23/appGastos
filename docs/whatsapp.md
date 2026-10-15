
# WhatsApp por texto: configuración y operación

Esta etapa admite un gasto por mensaje de texto. No admite conversaciones de varios turnos,
imágenes, audio, tickets, consultas financieras ni creación de catálogos por WhatsApp.
El código y las pantallas anteriores se conservan en modo demo explícito.

## Flujo

Webhook POST con firma válida → recepción durable en PostgreSQL → identificación del miembro
→ Gemini con catálogos de la familia → ExpenseCandidate → validación determinista
→ createExpense con source=whatsapp → COMMIT → respuesta por Meta.

El webhook devuelve 200 únicamente después de guardar los mensajes en PostgreSQL.
Una recepción que no se pudo guardar devuelve 503 para que Meta pueda reintentar.
200 confirma recepción técnica, no registro financiero.

El worker de Express revisa pendientes cada 2 segundos y recupera tareas con lease vencida.
No es un PendingExpense ni almacena una conversación. Cada mensaje se evalúa por separado.
El texto original se elimina de la fila al completar el procesamiento.
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

No hay una API web que permita cambiar credenciales reales. GET /api/whatsapp/config
solo devuelve indicadores de presencia e ID enmascarado; nunca devuelve el verify token.
POST /api/whatsapp/config responde 403 en modo normal.
Tras cambiar .env, reiniciar Express.

## Migración mínima

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
10. Enviar:
    Compré en Carrefour
    Debe pedir monto/medio de pago y cualquier otro dato no resuelto. No debe crear gasto.
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
