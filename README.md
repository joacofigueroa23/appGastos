# GastosFamilia - Control Financiero del Hogar & Bot de WhatsApp

Plataforma moderna de gestión de finanzas familiares con captura automática de gastos mediante WhatsApp (Meta WhatsApp Cloud API con motor de extracción inteligente Gemini 3.8 Flash), calendario preventivo de vencimientos de tarjetas de crédito y servicios, proyección de cuotas y reportes mensuales con balances de compensación.

---

## 🚀 Cómo ejecutar el proyecto en tu computadora local

### 1. Requisitos previos
- [Node.js](https://nodejs.org/) (versión 18 o superior recomendada).
- Una clave de API de Google Gemini (opcional para el procesamiento de lenguaje natural de WhatsApp, obtenible gratis en [Google AI Studio](https://aistudio.google.com/)).

### 2. Instalación de dependencias
Abre una terminal en la carpeta del proyecto y ejecuta:

```bash
npm install
```

### 3. Configuración de variables de entorno
Crea un archivo `.env` en la raíz copiando el ejemplo:

```bash
cp .env.example .env
```

Contenido de `.env`:
```env
GEMINI_API_KEY="tu_api_key_de_gemini"
PORT=3000
```

### 4. Iniciar el servidor de desarrollo
Ejecuta:

```bash
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
git remote add origin https://github.com/TU_USUARIO/gastos-familia.git

# Subir el código
git push -u origin main
```

---

## 📱 Conexión del Bot de WhatsApp (Meta Cloud API)

El servidor Express incluye el webhook oficial verificado para Meta WhatsApp Cloud API:

- **Endpoint de verificación (GET)**: `/api/whatsapp/webhook`
- **Endpoint de recepción de mensajes (POST)**: `/api/whatsapp/webhook`
- **Token de verificación por defecto**: `gastos_familia_meta_2026`

Cuando cualquier familiar envía un mensaje de texto (ej. *"Gasté $24.500 en Coto con Visa en 1 pago"*) o una foto de factura al número configurado, el webhook procesa la información y la agrega automáticamente a la base de datos de la página categorizada al instante.

---

## 🛠️ Tecnologías Utilizadas

- **Frontend**: React 19, TypeScript, Tailwind CSS, Lucide Icons.
- **Backend**: Express, Node.js (`server.ts`) con middlewares de Vite.
- **IA**: `@google/genai` con modelo `gemini-3.8-flash`.
