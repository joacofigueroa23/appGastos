import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

import { createDatabasePool } from './src/backend/db/pool';
import { registerDatabaseApi } from './src/backend/expenses/routes';
import { registerWhatsApp } from './src/backend/whatsapp/routes';
import { authFromEnv } from './src/backend/auth';
import { sessionAuth, supabaseFromEnv } from './src/backend/accounts/session';
import { registerAccounts } from './src/backend/accounts/routes';

dotenv.config();
// `npm start` pasa --production: evita servir Vite (código fuente) sin NODE_ENV, sin depender de cross-env en Windows.
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const databasePool = process.env.DATABASE_URL ? createDatabasePool(process.env.DATABASE_URL) : null;
// Con SUPABASE_URL y SUPABASE_ANON_KEY: sesión individual en /api (la web se sirve sin clave). Sin ellas: Basic Auth como antes.
const supabase = supabaseFromEnv();
const auth = authFromEnv();
if (auth) app.use(auth);
if (supabase) app.use(sessionAuth(databasePool, supabase));
// El demo (sin login, con rutas que gastan Gemini) nunca corre en producción.
const demo = process.env.VITE_ENABLE_DEMO === 'true';
if (demo && process.env.NODE_ENV === 'production') console.warn('VITE_ENABLE_DEMO=true ignorado en producción: se usa el modo real.');
const demoEnabled = demo && process.env.NODE_ENV !== 'production';
if (!demoEnabled) {
  registerWhatsApp(app, databasePool);
  app.use('/api/gemini/parse-expense', (_req, res) => res.status(410).json({error:'La interpretación real se utiliza únicamente desde el webhook firmado.'}));
} else {
  app.use('/api/whatsapp/webhook', (_req,res) => res.status(410).json({error:'El webhook real está deshabilitado en modo demo.'}));
}
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
if (demoEnabled) (await import('./src/backend/demoRoutes')).registerDemoRoutes(app);

registerAccounts(app, databasePool, supabase);
registerDatabaseApi(app, databasePool);

// ================= VITE DEV MIDDLEWARE & SERVIDO ESTÁTICO =================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, process.env.FRONTEND_DIST_DIR || 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, process.env.FRONTEND_DIST_DIR || 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  });
}

startServer();
