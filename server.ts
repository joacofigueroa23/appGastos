import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Configuración en memoria para el bot de WhatsApp Meta
let whatsappConfig = {
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'gastos_familia_meta_2026',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
};

// Historial en memoria de mensajes recibidos y respuestas del bot
interface StoredWhatsAppLog {
  id: string;
  timestamp: string;
  fromNumber: string;
  memberName?: string;
  rawMessage: string;
  extractedExpense?: any;
  status: 'success' | 'clarification_needed' | 'error';
  replySent: string;
}

const whatsappLogs: StoredWhatsAppLog[] = [
  {
    id: 'log-demo-1',
    timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
    fromNumber: '+54 9 11 4590-1234',
    memberName: 'Papá (Martín)',
    rawMessage: 'Gasté 28500 en Coto con Visa en 1 pago',
    extractedExpense: {
      description: 'Supermercado Coto',
      amount: 28500,
      currency: 'ARS',
      category: 'Supermercado',
      paymentMethod: 'Tarjeta de Crédito',
      isShared: true,
      installmentTotal: 1,
      installmentCurrent: 1,
    },
    status: 'success',
    replySent: '✅ Registrado: $28.500 en Supermercado (Visa Santander). Asignado a Gastos Comunes del Hogar.',
  },
  {
    id: 'log-demo-2',
    timestamp: new Date(Date.now() - 3600000 * 18).toISOString(),
    fromNumber: '+54 9 11 5821-7788',
    memberName: 'Mamá (Laura)',
    rawMessage: 'Pagué el colegio $85.000 por transferencia',
    extractedExpense: {
      description: 'Colegio de los chicos',
      amount: 85000,
      currency: 'ARS',
      category: 'Educación',
      paymentMethod: 'Transferencia',
      isShared: true,
      installmentTotal: 1,
      installmentCurrent: 1,
    },
    status: 'success',
    replySent: '✅ Registrado: $85.000 en Educación (Transferencia bancaria). ¡Cuentas al día!',
  },
];

// Helper para inicializar Gemini de forma segura
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY no configurada en las variables de entorno.');
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Función central para extraer datos estructurados de gastos usando Gemini 3.8 Flash
async function parseExpenseWithGemini(
  input: {
    message?: string;
    imageBase64?: string;
    mimeType?: string;
    memberName?: string;
    knownCards?: string[];
  }
) {
  const ai = getGeminiClient();
  const currentDate = new Date().toISOString().split('T')[0];

  const systemInstruction = `
Eres el asistente financiero oficial para una familia. Tu tarea es analizar mensajes de WhatsApp (texto coloquial, audios transcriptos o tickets de compra) y extraer datos estructurados del gasto para registrarlo de manera ordenada.
Fecha de referencia hoy: ${currentDate}.
Si el mensaje menciona cuotas (ej. "en 3 cuotas", "en 6 pagos"), extrae installmentTotal y calcula la primera cuota.
Si no especifica método de pago pero menciona tarjetas, detecta si es crédito o débito.
Si no menciona si es gasto compartido o individual, evalúa por la naturaleza del gasto: compras de supermercado, cuentas, colegio, luz, gas son normalmente compartidos (isShared: true). Ocio personal, ropa personal son isShared: false.
Genera un 'replyText' en español argentino/latinoamericano muy amable, claro y con emojis confirmando los detalles principales del gasto.
`;

  if (!ai) {
    // Fallback inteligente heurístico si aún no hay clave o modo sin conexión
    const raw = (input.message || '').trim();
    const amountMatch = raw.match(/\$?\s*([\d.]+([,.]\d{1,2})?)/);
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/\./g, '').replace(',', '.')) : 1000;
    const isCuotas = raw.toLowerCase().match(/(\d+)\s*(cuotas?|pagos?)/);
    const installmentTotal = isCuotas ? parseInt(isCuotas[1], 10) : 1;

    return {
      description: raw.slice(0, 40) || 'Gasto registrado por WhatsApp',
      amount: amount || 5000,
      currency: 'ARS',
      category: raw.toLowerCase().includes('super') || raw.toLowerCase().includes('coto') || raw.toLowerCase().includes('carrefour')
        ? 'Supermercado'
        : raw.toLowerCase().includes('nafta') || raw.toLowerCase().includes('combustible')
        ? 'Transporte & Combustible'
        : raw.toLowerCase().includes('luz') || raw.toLowerCase().includes('gas') || raw.toLowerCase().includes('internet')
        ? 'Servicios & Hogar'
        : 'Alimentación & Salidas',
      paymentMethod: installmentTotal > 1 ? 'Tarjeta de Crédito' : 'Billetera Virtual',
      isShared: true,
      installmentTotal,
      installmentCurrent: 1,
      cardName: raw.toLowerCase().includes('visa') ? 'Visa' : raw.toLowerCase().includes('master') ? 'Mastercard' : undefined,
      confidenceScore: 0.85,
      replyText: `✅ Registrado: $${amount.toLocaleString('es-AR')} en ${raw.slice(0, 30) || 'Gasto general'}${installmentTotal > 1 ? ` (${installmentTotal} cuotas)` : ''}.`,
    };
  }

  const promptContent: any[] = [];

  if (input.imageBase64 && input.mimeType) {
    promptContent.push({
      inlineData: {
        data: input.imageBase64,
        mimeType: input.mimeType,
      },
    });
  }

  const userPrompt = `
Mensaje recibido: "${input.message || 'Ticket adjunto'}"
Miembro de la familia: ${input.memberName || 'Familiar'}
Tarjetas conocidas de la familia: ${input.knownCards?.join(', ') || 'Visa Santander, Mastercard Galicia'}

Extrae el gasto respetando el esquema JSON.
`;
  promptContent.push({ text: userPrompt });

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: promptContent,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          description: {
            type: Type.STRING,
            description: 'Breve descripción clara del gasto (ej. Supermercado Coto, Nafta YPF)',
          },
          amount: {
            type: Type.NUMBER,
            description: 'Monto total de la compra o del pago expresado en números',
          },
          currency: {
            type: Type.STRING,
            description: 'Moneda (ARS, USD, EUR, etc.)',
          },
          category: {
            type: Type.STRING,
            description: 'Categoría exacta sugerida',
            enum: [
              'Supermercado',
              'Alimentación & Salidas',
              'Servicios & Hogar',
              'Transporte & Combustible',
              'Salud & Farmacia',
              'Educación',
              'Ocio & Entretenimiento',
              'Ropa & Cuidado Personal',
              'Tecnología & Equipamiento',
              'Mascotas',
              'Impuestos & Seguros',
              'Otros',
            ],
          },
          paymentMethod: {
            type: Type.STRING,
            description: 'Método de pago detectado',
            enum: [
              'Tarjeta de Crédito',
              'Tarjeta de Débito',
              'Efectivo',
              'Transferencia',
              'Billetera Virtual',
            ],
          },
          isShared: {
            type: Type.BOOLEAN,
            description: 'Verdadero si es un gasto común de la familia/hogar, falso si es individual',
          },
          installmentTotal: {
            type: Type.INTEGER,
            description: 'Total de cuotas (1 si fue de contado o débito)',
          },
          installmentCurrent: {
            type: Type.INTEGER,
            description: 'Cuota actual que se paga (generalmente 1)',
          },
          cardName: {
            type: Type.STRING,
            description: 'Nombre de la tarjeta identificada si aplica, o null',
          },
          confidenceScore: {
            type: Type.NUMBER,
            description: 'Confianza de la extracción de 0 a 1',
          },
          replyText: {
            type: Type.STRING,
            description: 'Respuesta amable en español confirmando el registro con emojis',
          },
        },
        required: [
          'description',
          'amount',
          'currency',
          'category',
          'paymentMethod',
          'isShared',
          'installmentTotal',
          'installmentCurrent',
          'replyText',
        ],
      },
    },
  });

  const rawText = response.text ? response.text.trim() : '{}';
  const parsed = JSON.parse(rawText);
  return parsed;
}

// ================= RUTAS API =================

// 1. Endpoint para extraer gastos usando Gemini
app.post('/api/gemini/parse-expense', async (req: Request, res: Response) => {
  try {
    const { message, imageBase64, mimeType, memberName, knownCards } = req.body;
    if (!message && !imageBase64) {
      return res.status(400).json({ error: 'Se requiere texto o imagen del gasto' });
    }

    const result = await parseExpenseWithGemini({
      message,
      imageBase64,
      mimeType,
      memberName,
      knownCards,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error parseando gasto con Gemini:', error);
    res.status(500).json({
      error: 'Error al interpretar el gasto con inteligencia artificial',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// 2. Meta WhatsApp Webhook: Verificación GET
// Meta invoca este endpoint al configurar el Webhook en developers.facebook.com
app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === whatsappConfig.verifyToken) {
    console.log('✅ Webhook de Meta WhatsApp verificado exitosamente!');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Verificación fallida de Webhook de WhatsApp. Token incorrecto o modo inválido.');
  return res.status(403).json({ error: 'Verificación fallida del token de webhook' });
});

// 3. Meta WhatsApp Webhook: Recepción de mensajes POST
app.post('/api/whatsapp/webhook', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    // Confirmar recepción inmediatamente para cumplir con el SLA de Meta (< 3 segundos)
    res.status(200).send('EVENT_RECEIVED');

    if (body.object === 'whatsapp_business_account') {
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;
          if (value && value.messages && value.messages.length > 0) {
            for (const message of value.messages) {
              const from = message.from;
              let textContent = '';

              if (message.type === 'text') {
                textContent = message.text.body;
              } else if (message.type === 'audio') {
                textContent = 'Nota de voz recibida (Audio de WhatsApp)';
              } else if (message.type === 'image') {
                textContent = message.image.caption || 'Foto de ticket/factura recibida';
              }

              console.log(`📩 Mensaje entrante de WhatsApp [${from}]: ${textContent}`);

              // Procesar con Gemini
              try {
                const extracted = await parseExpenseWithGemini({
                  message: textContent,
                  memberName: `WhatsApp (${from})`,
                });

                // Registrar en logs
                const newLog: StoredWhatsAppLog = {
                  id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                  timestamp: new Date().toISOString(),
                  fromNumber: from,
                  memberName: `WhatsApp (${from})`,
                  rawMessage: textContent,
                  extractedExpense: extracted,
                  status: 'success',
                  replySent: extracted.replyText,
                };
                whatsappLogs.unshift(newLog);

                // Si está configurado el Token de Acceso de Meta Cloud API, responder por WhatsApp
                if (whatsappConfig.accessToken && whatsappConfig.phoneNumberId) {
                  await sendWhatsAppMessage(from, extracted.replyText);
                }
              } catch (parseErr) {
                console.error('Error procesando mensaje de WhatsApp con Gemini:', parseErr);
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error procesando webhook de WhatsApp:', error);
  }
});

// Helper para enviar mensaje de WhatsApp usando la API de Meta Graph
async function sendWhatsAppMessage(to: string, message: string) {
  if (!whatsappConfig.accessToken || !whatsappConfig.phoneNumberId) {
    console.log('Envío real omitido: Falta access token o phone number ID de Meta.');
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${whatsappConfig.phoneNumberId}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whatsappConfig.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      }),
    });
    const data = await response.json();
    console.log('Respuesta de Meta WhatsApp API:', data);
  } catch (err) {
    console.error('Error enviando mensaje a Meta WhatsApp API:', err);
  }
}

// 4. Simulador interactivo de WhatsApp en pantalla
app.post('/api/whatsapp/simulate', async (req: Request, res: Response) => {
  try {
    const { message, fromNumber, memberName, imageBase64, mimeType } = req.body;

    if (!message && !imageBase64) {
      return res.status(400).json({ error: 'Mensaje o imagen requerida para la simulación' });
    }

    const extracted = await parseExpenseWithGemini({
      message,
      imageBase64,
      mimeType,
      memberName: memberName || 'Familiar',
    });

    const newLog: StoredWhatsAppLog = {
      id: `sim-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      fromNumber: fromNumber || '+54 9 11 9999-0000',
      memberName: memberName || 'Familiar',
      rawMessage: message || 'Foto de ticket enviada',
      extractedExpense: extracted,
      status: 'success',
      replySent: extracted.replyText,
    };

    whatsappLogs.unshift(newLog);

    res.json({
      success: true,
      log: newLog,
      extractedExpense: extracted,
      replyMessage: extracted.replyText,
    });
  } catch (err) {
    console.error('Error simulando WhatsApp:', err);
    res.status(500).json({
      error: 'Error en la simulación de WhatsApp',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

// 5. Consulta y guardado de configuración de WhatsApp Meta
app.get('/api/whatsapp/config', (_req: Request, res: Response) => {
  res.json({
    verifyToken: whatsappConfig.verifyToken,
    phoneNumberId: whatsappConfig.phoneNumberId ? '••••••••' + whatsappConfig.phoneNumberId.slice(-4) : '',
    hasAccessToken: !!whatsappConfig.accessToken,
    businessAccountId: whatsappConfig.businessAccountId || '',
    webhookUrl: `${process.env.APP_URL || 'https://ais-dev-tr4hptepvhtbkovsqmaztu-880139466294.us-east1.run.app'}/api/whatsapp/webhook`,
  });
});

app.post('/api/whatsapp/config', (req: Request, res: Response) => {
  const { verifyToken, phoneNumberId, accessToken, businessAccountId } = req.body;
  if (verifyToken) whatsappConfig.verifyToken = verifyToken;
  if (phoneNumberId !== undefined) whatsappConfig.phoneNumberId = phoneNumberId;
  if (accessToken) whatsappConfig.accessToken = accessToken;
  if (businessAccountId !== undefined) whatsappConfig.businessAccountId = businessAccountId;

  res.json({ success: true, message: 'Configuración de Meta WhatsApp actualizada con éxito.' });
});

// 6. Obtener historial de mensajes de WhatsApp
app.get('/api/whatsapp/logs', (_req: Request, res: Response) => {
  res.json({ logs: whatsappLogs });
});

// ================= VITE DEV MIDDLEWARE & SERVIDO ESTÁTICO =================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  });
}

startServer();
