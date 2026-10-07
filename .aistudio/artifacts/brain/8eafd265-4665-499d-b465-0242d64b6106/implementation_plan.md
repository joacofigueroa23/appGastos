# Plataforma de Gestión de Gastos Familiares & Bot de WhatsApp

Sistema integral de finanzas familiares diseñado para centralizar gastos compartidos y personales, automatizar la captura de tickets y compras mediante WhatsApp (Meta WhatsApp Cloud API con motor de extracción inteligente Gemini 3.8 Flash), supervisar vencimientos de tarjetas de crédito y servicios con calendario interactivo, y generar reportes financieros mensuales automáticos en un panel central de alta fidelidad.

---

### Decisiones Críticas y Confirmaciones del Usuario

> [!IMPORTANT]
> A partir de las aclaraciones confirmadas en la Fase 1, se han fijado las siguientes definiciones arquitectónicas y de experiencia:

- **Canal de automatización de WhatsApp**: Integración directa con **Meta WhatsApp Cloud API** (endpoint de webhook para recepción de mensajes, audios e imágenes de tickets en tiempo real, complementado con un simulador visual en el panel web para pruebas inmediatas y configuración guiada de tokens/webhooks).
- **Control de Vencimientos y Tarjetas**: **Calendario interactivo con semáforo de alertas** (vencimientos de resúmenes de tarjetas de crédito, fechas de corte, cuotas restantes e impuestos/servicios recurrentes).
- **Estructura Familiar**: **Multimiembro familiar** (distinción entre gastos comunes del hogar y gastos personales por cada integrante, con filtros, presupuestos y distribución equitativa).

---

### 1. Resumen y Concepto Central

- **¿Qué resuelve?**: Elimina el desorden y el olvido de comprobantes en los gastos del hogar. Los miembros de la familia pueden registrar un gasto simplemente enviando un mensaje de texto, foto de factura o nota de voz a WhatsApp (ej. *"Compré carne y carbón $24.500 en 1 pago con Visa"*), o ingresándolo manualmente en la web con cálculo de cuotas.
- **Público Objetivo**: Parejas y familias que administran un presupuesto común, tarjetas de crédito compartidas o individuales, y servicios del hogar con fechas límite de pago.
- **Valor Principal**:
  1. Captura con cero fricción: procesado natural vía WhatsApp y Gemini 3.8 Flash.
  2. Cero sorpresas en resúmenes bancarios: calendario visual con días clave de cierre y vencimiento de tarjetas.
  3. Visibilidad total: panel financiero con métricas de ahorro, desglose por categoría y reportes mensuales descargables.

---

### 2. Experiencia de Usuario y Diseño Visual

#### Flujos Clave de Usuario
1. **Panel Central (Dashboard Ejecutivo)**:
   - Resumen del mes en curso: Total gastado, presupuesto familiar restante, gastos comunes vs. personales, y saldo comprometido en cuotas.
   - Gráfico de distribución por categoría (Alimentación, Servicios, Transporte, Ocio, Salud, Educación).
   - Acceso rápido a *"Nuevo Gasto Rápido"* y vista de últimos movimientos con filtros dinámicos.
2. **Calendario Financiero & Agenda de Vencimientos**:
   - Vista mensual tipo cuadrícula y cronograma semanal.
   - Semáforo de urgencia:
     - Rojo: Vencido o vence en las próximas 24 horas.
     - Ámbar: Vence en los próximos 7 días.
     - Verde: Pagado o programado sin deuda pendiente.
   - Fichas detalladas de tarjetas: límite disponible, fecha de corte, fecha de vencimiento del resumen y cuotas mensuales fijas activas (ej. *"Lavarropas - Cuota 4/12"*).
3. **Módulo de WhatsApp & Simulador de Mensajes**:
   - Asistente de configuración de Meta WhatsApp Cloud API (Webhook URL, Verify Token, Phone Number ID y Access Token).
   - Consola de prueba interactiva donde cualquier integrante de la familia puede simular el envío de mensajes ("Gasté 8500 en Farmacia con débito") para verificar la categorización y guardado en tiempo real sin salir del navegador.
4. **Reportes Mensuales y Análisis Familiar**:
   - Comparativa mes a mes, gasto promedio por miembro, balance de compensación (quién pagó qué y cuánto debe reintegrar cada uno para gastos comunes).
   - Exportación de resúmenes estructurados en formato CSV / resumen imprimible.

#### Identidad Visual y Estilo
- **Dirección Estética**: SaaS financiero moderno, sobrio y editorial, inspirado en interfaces profesionales como Stripe y Linear.
- **Tipografía**:
  - Títulos y navegación: `Plus Jakarta Sans` con peso seminegrilla y tracking ajustado.
  - Métricas monetarias y tablas: `JetBrains Mono` con cifras tabulares fijas (`tabular-nums`) para evitar saltos visuales al comparar saldos.
- **Paleta de Color (Regla 60-30-10)**:
  - Fondo Canvas (60%): Pizarra neutra clara (`#F8FAFC`) con soporte para modo oscuro profundo (`#0B0F19`).
  - Superficies Estructurales (30%): Tarjetas blancas puras (`#FFFFFF`) con bordes ultra-delgados (`border border-slate-200/80`), sin elevaciones exageradas ni sombras difusas.
  - Acentos de Acción (10%): Azul índigo de alta intención (`#2563EB`) para acciones primarias, verde esmeralda (`#059669`) para estados solventes y cobros, y rojo carmesí (`#DC2626`) para alertas de vencimiento crítico.
- **Disciplina Anti-Slop**:
  - Sin píldoras estáticas decorativas para metadatos; fechas y categorías se muestran como texto limpio con separadores sutiles (`·`).
  - Sin encabezados con sintaxis de código (`// 01 GASTOS`). Títulos naturales en español bien estructurados.
  - Botones y controles de una sola línea con truncamiento seguro.

---

### 3. Decisiones de Producto y Compensaciones (Trade-Offs)

1. **Meta WhatsApp Cloud API + Simulador de Webhook**:
   - *Decisión*: Proporcionar el endpoint oficial de webhook para Meta Cloud API (`/api/whatsapp/webhook`), junto con un simulador integrado en la interfaz gráfica.
   - *Motivo*: Permite vincular el bot real de Meta para producción, pero garantiza que la familia pueda utilizar, probar y registrar gastos vía simulación de chat en vivo inmediatamente sin esperar la aprobación de plantillas de Meta Business.
2. **Motor de Comprensión con Gemini 3.8 Flash**:
   - *Decisión*: Extracción estructurada mediante `@google/genai` en el servidor con esquema JSON estricto (`Type.OBJECT`).
   - *Motivo*: Gemini 3.8 Flash comprende jerga local, modismos monetarios (pesos, cuotas, transferencias), audios y fotografías de tickets, extrayendo monto, comercio, categoría, método de pago y fecha con mínima latencia y costo óptimo.
3. **Gestión de Cuotas y Vencimientos**:
   - *Decisión*: Motor de cálculo de cuotas que proyecta automáticamente el impacto en los meses futuros cuando se registra una compra en cuotas (ej. compra en 6 cuotas distribuye los vencimientos en los siguientes 6 resúmenes).
   - *Motivo*: Refleja la realidad financiera familiar donde los resúmenes de tarjeta comprometen ingresos de meses venideros.

---

### 4. Arquitectura Técnica y Estrategia de Datos

```
┌────────────────────────────────────────────────────────────────────────┐
│                          INTERFAZ DE USUARIO                           │
│  ┌──────────────────┐  ┌───────────────────┐  ┌─────────────────────┐  │
│  │ Panel Financiero │  │ Calendario & Citas│  │ Simulador / Config  │  │
│  │ (Métricas/Gráficos) │ (Tarjetas/Servicios)│ │ WhatsApp Meta API   │  │
│  └─────────┬────────┘  └─────────┬─────────┘  └──────────┬──────────┘  │
└────────────┼─────────────────────┼───────────────────────┼─────────────┘
             │                     │                       │
             ▼                     ▼                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        ESTADO Y LÓGICA FRONTEND                        │
│  - Gestor de Integrantes Familiares (Gastos comunes vs. individuales) │
│  - Motor de Proyección de Cuotas y Semáforo de Vencimientos           │
│  - Filtros por Categoría, Período, Medio de Pago y Miembro             │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        BACKEND API (EXPRESS / VITE)                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ POST /api/whatsapp/webhook (Meta Cloud API Verificación & Msg)   │  │
│  │ POST /api/gemini/parse-expense (Gemini 3.8 Flash Schema Parser)  │  │
│  │ GET/POST /api/expenses (Gestión sincronizada de gastos y cuotas) │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   PERSISTENCIA & INTEGRACIÓN REMOTA                    │
│  - Modelos: Gastos, Cuotas, Tarjetas, Servicios, Integrantes, Logs     │
│  - Sincronización continua y exportación de respaldos familiares       │
└────────────────────────────────────────────────────────────────────────┘
```

#### Entidades Principales del Modelo de Datos
- **FamilyMember**: `id`, `name`, `avatar`, `role`, `color`, `monthlyBudget`.
- **Expense**: `id`, `description`, `amount`, `currency`, `category`, `date`, `paymentMethod`, `paidByMemberId`, `isShared`, `installmentCurrent`, `installmentTotal`, `receiptUrl`, `source` (`"whatsapp"` | `"manual"`).
- **CreditCard & Account**: `id`, `name`, `bank`, `lastDigits`, `closingDay`, `dueDay`, `creditLimit`, `ownerMemberId`.
- **BillDue**: `id`, `title`, `serviceCategory`, `amount`, `dueDate`, `status` (`"pending"` | `"paid"` | `"overdue"`), `autoDebit`.
- **MonthlyReport**: `monthYear`, `totalSpent`, `sharedTotal`, `breakdownByCategory`, `breakdownByMember`, `debtBalances`.

---

### 5. Plan de Ejecución por Fases (Tras Aprobación)

1. **Fase 1: Configuración de Tipos, Modelos y Rutas de Servidor**:
   - Definición de tipos TypeScript para miembros, gastos, cuotas y tarjetas.
   - Creación de rutas de servidor para el webhook de Meta WhatsApp y el endpoint de extracción de Gemini 3.8 Flash.
2. **Fase 2: Motor de Procesamiento Inteligente (Gemini 3.8 Flash)**:
   - Esquema de extracción de texto, audio e imágenes para convertir mensajes coloquiales en registros financieros normalizados.
3. **Fase 3: Panel Central y Métricas Financieras**:
   - Componentes de resumen ejecutivo, desglose por categoría con porcentajes, comparador de gastos compartidos y filtro por miembro.
4. **Fase 4: Calendario de Vencimientos y Control de Tarjetas**:
   - Vista de calendario interactivo con semáforo de vencimientos, control de fechas de corte y visualización de cuotas pendientes.
5. **Fase 5: Módulo de Meta WhatsApp Cloud & Simulador en Pantalla**:
   - Formulario de configuración de credenciales de Meta y chat simulador interactivo para pruebas instantáneas.
6. **Fase 6: Reportes Mensuales, Exportación y Validación Final**:
   - Generación de reportes automáticos mensuales con saldos cruzados familiares, verificación de compilación y pruebas de flujo completas.
