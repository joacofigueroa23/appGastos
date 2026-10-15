-- Conversación de WhatsApp para completar UN gasto en varios mensajes.
-- Sesión y borrador en una tabla (relación 1:1). No modifica filas existentes.
CREATE TABLE appgastos.whatsapp_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 member_id uuid NOT NULL,
 channel text NOT NULL DEFAULT 'whatsapp' CHECK(channel IN ('whatsapp')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','confirmed','cancelled','expired','error')),
 draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(draft)='object'),
 expected_field text CHECK(expected_field IS NULL OR expected_field IN ('amount','paymentMethod','card','category','date')),
 unknown_count integer NOT NULL DEFAULT 0 CHECK(unknown_count BETWEEN 0 AND 3),
 version integer NOT NULL DEFAULT 0,
 expense_id uuid REFERENCES appgastos.expenses(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 closed_at timestamptz,
 FOREIGN KEY(family_id,member_id) REFERENCES appgastos.family_members(family_id,id) ON DELETE RESTRICT,
 CHECK(expense_id IS NULL OR status='confirmed'),
 CHECK((status='active') = (closed_at IS NULL))
);
REVOKE ALL ON appgastos.whatsapp_conversations FROM PUBLIC;
ALTER TABLE appgastos.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
-- Como máximo una conversación activa por integrante.
CREATE UNIQUE INDEX whatsapp_conversations_one_active ON appgastos.whatsapp_conversations(family_id,member_id) WHERE status='active';
CREATE INDEX whatsapp_conversations_expense_idx ON appgastos.whatsapp_conversations(expense_id) WHERE expense_id IS NOT NULL;

-- Relación mensaje → conversación y hora real del mensaje según Meta (los históricos quedan NULL).
ALTER TABLE appgastos.whatsapp_messages
 ADD COLUMN conversation_id uuid REFERENCES appgastos.whatsapp_conversations(id) ON DELETE RESTRICT,
 ADD COLUMN meta_timestamp timestamptz;
ALTER TABLE appgastos.whatsapp_messages DROP CONSTRAINT whatsapp_messages_outcome_check;
ALTER TABLE appgastos.whatsapp_messages ADD CONSTRAINT whatsapp_messages_outcome_check CHECK(outcome IN
 ('registered','incomplete','unauthorized','unsupported','interpretation_error',
  'question','corrected','cancelled','pending_conflict','nothing_to_cancel','unrecognized'));
-- Orden por remitente: un mensaje no se procesa mientras haya otro anterior del mismo remitente sin completar.
CREATE INDEX whatsapp_messages_sender_order_idx ON appgastos.whatsapp_messages
 (family_id, sender, (COALESCE(meta_timestamp,received_at)), received_at, message_id) WHERE state <> 'completed';
CREATE INDEX whatsapp_messages_conversation_idx ON appgastos.whatsapp_messages(conversation_id) WHERE conversation_id IS NOT NULL;
