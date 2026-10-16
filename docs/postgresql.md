# AppGastos: PostgreSQL y carga manual

Estado: implementado y probado contra PostgreSQL local temporal. La aplicación usa PostgreSQL por defecto.
La aplicación no accede a Supabase desde React. Express utiliza pg y el esquema privado appgastos.
No se activan Supabase Auth, RLS, Storage, Edge Functions ni Realtime.
Las funciones anteriores siguen en el repositorio y en el modo demo explícito.

## Configurar Supabase

1. Seleccionar el proyecto destinado a AppGastos en el dashboard de Supabase. Debe estar activo.
2. Abrir Connect y copiar la conexión PostgreSQL en modo Session pooler, puerto 5432, apropiada para Express persistente y redes IPv4.
   Si la red soporta IPv6, también se puede utilizar la conexión directa.
3. Sustituir el marcador de contraseña por la contraseña PostgreSQL del proyecto, codificada para URL.
   No usar la anon key ni una service_role key como contraseña de PostgreSQL.
4. Guardar la cadena únicamente en el .env local que está junto a package.json.
   DATABASE_URL nunca lleva prefijo VITE_.
5. Si el certificado del servidor no está reconocido, descargar el certificado raíz desde la configuración SSL de la base y configurar DATABASE_CA_FILE.
   Se verifica TLS en conexiones remotas; no se desactiva rejectUnauthorized.
6. No ejecutar migraciones hasta verificar que esta URL corresponde al proyecto correcto.

Ejemplo de configuración SIN credenciales reales:
```env
PORT=3000
DATABASE_URL=postgresql://USUARIO:CONTRASENA_URL_ENCODED@HOST:5432/postgres
APP_FAMILY_ID=00000000-0000-4000-8000-000000000001
APP_AUTH_USER=elegir-usuario
APP_AUTH_PASSWORD=elegir-clave-larga
SEED_FAMILY_NAME=Familia
# Opcional: crea un integrante que configures explícitamente.
# SEED_MEMBER_NAME=Nombre elegido
# Opcional: ruta local al certificado raíz del servidor.
# DATABASE_CA_FILE=C:/certificados/prod-supabase.cer
# El flujo manual no necesita GEMINI_API_KEY.
```

No compartir el .env ni contraseñas por chat. El ejemplo anterior contiene marcadores, no una conexión utilizable.

## Levantar desde cero en PowerShell

Abrir la carpeta interior appGastos que contiene package.json y server.ts:

```powershell
npm ci
# Crear/configurar .env local siguiendo la sección anterior.
npm run db:migrate
npm run db:seed
npm run dev
```

Abrir http://localhost:3000. No hacer npm run preview para el circuito completo: sirve solamente el frontend y no inicia Express.

El seed inicial agrega una familia y el catálogo anterior de 12 categorías.
No inserta tarjetas ni gastos. Un integrante se crea solo al definir SEED_MEMBER_NAME.
La misma familia se puede volver a sembrar sin duplicar categorías.
APP_FAMILY_ID se configura en el servidor; no se toma del JSON enviado por el navegador.
Si no está configurado, el servidor exige exactamente una familia existente.

Para el ejemplo del usuario:
1. Abrir + Gasto.
2. Descripción: Compra familiar; fecha: 2026-10-08; monto: 40000; moneda: ARS; comercio: Carrefour.
3. Categoría: Supermercado; medio: Tarjeta de crédito.
4. Si Visa aún no existe, escribir Visa en Nombre de nueva tarjeta y pulsar Agregar tarjeta.
   Esta creación es explícita; el seed no inventa tarjetas.
5. Seleccionar Visa, guardar y abrir Historial de Gastos.
6. En el dashboard seleccionar 2026-10 y ARS: total 40.000,00 si no existen otros gastos para ese mes.
7. Recargar. Los gastos vuelven a consultarse desde PostgreSQL.

Producción local con assets compilados:

```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

Para volver a desarrollo, quitar NODE_ENV de la sesión o asignar development.
La API y el frontend piden Basic Auth con APP_AUTH_USER y APP_AUTH_PASSWORD (el navegador pregunta una vez). Con NODE_ENV=production el servidor no arranca sin ellas. Solo /api/whatsapp/webhook queda exento: valida la firma de Meta. Nunca usar variables VITE_* para esto: quedarían en el JavaScript público.

## Migraciones y seed

supabase/migrations/20261008230119_appgastos_core.sql crea el esquema, tablas, índices y trigger.
No contiene DROP ni migra datos del navegador.
scripts/migrate.ts registra nombre/checksum en appgastos.schema_migrations y usa transacciones y bloqueo.
No modificar una migración aplicada: crear una siguiente.
El ejecutor de este proyecto es npm run db:migrate; no alternarlo con supabase db push porque usan registros distintos.
La CLI de Supabase se utilizó para crear el archivo versionado; no es dependencia de la aplicación.

Familias, integrantes, categorías y tarjetas tienen UUID.
Los gastos tienen NUMERIC(14,2), DATE, moneda explícita y TIMESTAMPTZ.
Las FK compuestas impiden referencias a otra familia.
Eliminar una tarjeta/categoría usada está restringido; se desactiva con active=false.
Un PATCH puede conservar referencias históricas inactivas, pero una creación o cambio no puede elegirlas.
Los nombres de categoría provienen de PostgreSQL en formulario, filtros y dashboard.
El archivo financeCatalog se conserva como definición del seed inicial y catálogo del modo demo.
No hay medios de pago, categorías ni tarjetas inferidas.

## API

Todas las respuestas son JSON, salvo DELETE exitoso (204).
Los montos viajan como cadenas decimales; las fechas como YYYY-MM-DD.

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | /api/expenses | {expenses}; filtros opcionales month, currency, categoryId, paymentMethod, cardId, reportedByMemberId y merchant |
| POST | /api/expenses | {expense}, 201 |
| GET | /api/expenses/:id | {expense} |
| PATCH | /api/expenses/:id | {expense}; campos parciales |
| DELETE | /api/expenses/:id | 204 |
| GET | /api/categories | {categories} |
| GET | /api/cards | {cards} |
| POST | /api/cards | {card}; name y active opcional |
| PATCH | /api/cards/:id | {card}; name y/o active |
| GET | /api/family-members | {members} |
| POST | /api/family-members | {member}; name, phoneNumber nullable, active opcional |
| PATCH | /api/family-members/:id | {member}; name, phoneNumber y/o active |

POST de gasto:
```json
{
  "date": "2026-10-08",
  "amount": "40000.00",
  "currency": "ARS",
  "merchant": "Carrefour",
  "description": "Compra familiar",
  "categoryId": "UUID_REAL_SUPERMERCADO",
  "paymentMethod": "credit_card",
  "cardId": null,
  "reportedByMemberId": null
}
```

Usar UUID reales consultados por API. source y familyId no se aceptan desde el cliente.
source se establece a manual en la ruta. El servicio central permite whatsapp para una integración futura, no implementada.
cardId solo puede acompañar debit_card o credit_card, y puede quedar null incluso con esos medios.
Sin base o conexión, la aplicación muestra error; no activa demo ni guarda localmente.

## localStorage y demo

No se leen, borran ni importan claves gf_* en el modo normal.
El contexto nuevo administra estado/loading/errores y resultados API.
La lógica anterior y fixtures de initialData siguen preservados.
Para revisar la funcionalidad anterior explícitamente:
```powershell
$env:VITE_ENABLE_DEMO="true"
npm run dev
# Al terminar, quitar el flag y reiniciar:
Remove-Item Env:VITE_ENABLE_DEMO
```
En un build, el flag se decide al compilar: cambiarlo después no cambia los assets.
El modo demo mantiene su comportamiento de localStorage y no envía gastos a PostgreSQL.
No usarlo para cargar datos reales durante la transición.

## Verificación

```powershell
npm run lint
npm test
npm run build
npm run test:browser
npm run test:legacy-browser
```

npm test crea un clúster PostgreSQL aislado en el directorio temporal; nunca usa DATABASE_URL para pruebas.
Por defecto busca C:/Program Files/PostgreSQL/17/bin.
Configurar TEST_PG_BIN si los binarios Windows están en otra ubicación.
Las pruebas de navegador requieren Chrome/Edge instalado; MANUAL_TEST_BROWSER permite indicar el ejecutable.
Se usan perfiles temporales y puertos separados. Se detienen los procesos de prueba y se conservan archivos temporales para diagnóstico.
La prueba legacy genera dist-demo sin reemplazar dist.

Cubierto: CRUD, exactitud decimal/fecha, referencias, tarjetas, integrante, source,
moneda/período, restricciones SQL, conexión nueva, CLI de migración/seed, recarga,
reinicio de Express, zona horaria y falla de red sin respaldo local.
Falta validar la misma configuración contra el proyecto Supabase elegido.

## Pendientes fuera de esta etapa

Autenticación/autorización antes de exposición pública; paginación para historiales grandes;
gestión de categorías, importación manual validada y decisión sobre datos locales.
No se conectaron calendario, compensaciones, cuotas avanzadas ni WhatsApp a PostgreSQL.


## Núcleo manual completado

En el modo normal, la pestaña Tarjetas e integrantes permite crear y editar nombres,
guardar un teléfono opcional y activar/desactivar registros. No hay borrado físico
de tarjetas ni integrantes desde la API o la interfaz.
Ninguno se crea por defecto. Crear una tarjeta no la selecciona en el formulario de gasto.

Los inactivos quedan visibles para gestión, historial y filtros.
No aparecen en el selector del navbar ni como opciones nuevas en la carga manual.
Al editar un gasto se puede conservar la tarjeta/integrante inactivo ya referenciado.
Si se desactiva el integrante seleccionado en el navbar, se limpia esa selección.
Editar un gasto sin informante conserva null aunque el navbar tenga una selección.

El historial ofrece mes, categoría por ID, medio, tarjeta, informante y comercio,
además de la búsqueda existente y Limpiar filtros.
La interfaz filtra el conjunto de gastos consultado por API; no modifica la colección
principal ni el conjunto utilizado por dashboard.
La API también ofrece esos filtros con consultas parametrizadas. El comercio
se busca por coincidencia parcial sin distinguir mayúsculas, tratando % como texto literal.
Los totales del historial se mantienen separados por moneda.

El dashboard conserva total del período, cantidad, categoría, medio y tarjeta;
efectivo mantiene un bloque separado. Todas las métricas se actualizan desde el
estado respaldado por respuestas de PostgreSQL después de crear, editar y borrar.
No se agregó comparación con el mes anterior ni análisis simulado.

Pruebas nuevas:
- tests/manual-core.test.ts: gestión de catálogos, edición completa, seis filtros,
  validación, aislamiento familiar y referencias históricas.
- tests/manual-core-browser.test.ts: interfaz de gestión, filtros, CRUD,
  dashboard, recarga/reinicio y error de eliminación.
Se mantienen las pruebas anteriores del flujo PostgreSQL y del modo demo.
No se agregó migración ni dependencia en esta etapa.
