# GastosFamilia - Control Financiero del Hogar & Bot de WhatsApp

Carga manual de gastos con React + TypeScript + Express + PostgreSQL (alojamiento previsto en Supabase). El flujo normal consulta la API Express y no activa gastos demo. WhatsApp por texto utiliza el mismo servicio central de gastos. Calendario, proyección de cuotas, balances y simulador anteriores siguen preservados fuera de prioridad actual.

**Configuración completa y verificación:** [docs/postgresql.md](docs/postgresql.md). La conexión al proyecto Supabase debe configurarse en el entorno local antes de utilizar el flujo real.

---

## 🚀 Cómo ejecutar el proyecto en tu computadora local

### 1. Requisitos previos
- [Node.js](https://nodejs.org/) (Node 22.12 o superior; Node 20.19 también es compatible).
- Una clave de API de Google Gemini (opcional para el procesamiento de lenguaje natural de WhatsApp, obtenible en [Google AI Studio](https://aistudio.google.com/)).

### 2. Instalación de dependencias
Abre una terminal en la carpeta del proyecto y ejecuta:

```bash
npm ci
```

### 3. Configuración de variables de entorno
Crea un archivo `.env` local en la carpeta que contiene `package.json`. No lo subas a Git.

Contenido de `.env`:
```env
PORT=3000
DATABASE_URL=postgresql://USUARIO:CONTRASENA_URL_ENCODED@HOST:5432/postgres
APP_FAMILY_ID=00000000-0000-4000-8000-000000000001
# GEMINI_API_KEY es opcional y no se utiliza en la carga manual.
```

### 4. Iniciar el servidor de desarrollo
Ejecuta:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

La aplicación estará lista en tu navegador en:
👉 `http://localhost:3000`

---

## 📦 Cómo subir el código a GitHub

Si deseas llevar el repositorio a tu cuenta de GitHub, sigue estos pasos en tu terminal:

1. Crea un nuevo repositorio vacío en [github.com/new](https://github.com/new) (por ejemplo: `gastos-familia`).
2. En la terminal de la carpeta del proyecto, ejecuta:

```bash
# Inicializar repositorio git si no está inicializado
git init

# Agregar todos los archivos
git add .

# Crear el primer commit
git commit -m "feat: versión inicial de GastosFamilia con bot de WhatsApp y calendario"

# Renombrar rama a main
git branch -M main

# Vincular tu repositorio remoto de GitHub (reemplaza TU_USUARIO por tu nombre de usuario)
git remote add origin https://github.com/joacofigueroa23/gastos-familia.git

# Subir el código
git push -u origin main
```

---

## 📱 Conexión del Bot de WhatsApp (Meta Cloud API)

El servidor Express incluye el webhook oficial verificado para Meta WhatsApp Cloud API:

- **Endpoint de verificación (GET)**: `/api/whatsapp/webhook`
- **Endpoint de recepción de mensajes (POST)**: `/api/whatsapp/webhook`
- **Token de verificación por defecto**: `WHATSAPP_VERIFY_TOKEN` del entorno (sin valor predeterminado)

El webhook firmado recibe únicamente gastos por texto de integrantes activos identificados por teléfono. Gemini interpreta; el backend valida referencias reales y registra mediante el servicio existente en PostgreSQL. Si falta un dato, el bot pregunta de a uno y registra un único gasto al completarlo. El ID único del mensaje evita duplicados; la confirmación se envía después del COMMIT. Imágenes y audios no se interpretan como gastos.

**Configuración, seguridad y prueba con tu número real:** [docs/whatsapp.md](docs/whatsapp.md).

---

## 🛠️ Tecnologías Utilizadas

- **Frontend**: React 19, TypeScript, Tailwind CSS, Lucide Icons.
- **Backend**: Express, Node.js (`server.ts`) con middlewares de Vite y driver pg.
- **Persistencia**: PostgreSQL; migraciones y seed separados.
- **IA**: `@google/genai` con modelo `gemini-3.8-flash`.

## Alcance estabilizado: carga manual
- Una economía familiar; el integrante identifica quién cargó o informó el gasto.
- Montos ARS positivos con hasta dos decimales: 1234.56 conserva su valor.
- Fechas literales YYYY-MM-DD, sin conversión UTC.
- Categoría y medio de pago requieren selección explícita.
- Tarjeta opcional: id, name y active. No se elige una tarjeta por defecto.
- Calendario, vencimientos, bancos, límites, compensaciones y balances
  se conservan fuera de prioridad. No se migran ni borran registros anteriores.
- Dashboard: período y moneda elegidos (ARS por defecto), con totales, categorías, medios y tarjetas del mismo conjunto de gastos. Historial: totales separados por moneda.
- Guardado por API Express en PostgreSQL. localStorage se conserva sin importar ni eliminar sus datos; solo se usa en el modo demo explícito.
- Ante fallo de guardado, el formulario permanece abierto y muestra el error.
- Sin Gemini o ante errores de red, no se inventan gastos.
- Credenciales únicamente en el entorno. Las claves previamente expuestas
  deben rotarse en el proveedor; retirarlas del archivo no las revoca.

Verificación (base y perfiles temporales, sin modificar datos productivos):
```powershell
npm run lint
npm test
npm run build
npm run test:browser
npm run test:legacy-browser
```
Los requisitos y comandos de demo, migración, seed, producción y Supabase están detallados en [docs/postgresql.md](docs/postgresql.md).


## Gestión y filtros del núcleo manual

La pestaña Tarjetas e integrantes permite crear, editar y activar/desactivar tarjetas
e integrantes de la familia. Los inactivos conservan sus referencias históricas.
El historial permite filtrar por mes, categoría, medio de pago, tarjeta, informante y comercio.
El CRUD completo y el dashboard se verifican con las pruebas del núcleo manual
descritas en docs/postgresql.md. La etapa WhatsApp agrega una migración independiente de recepción e idempotencia, detallada en [docs/whatsapp.md](docs/whatsapp.md).
