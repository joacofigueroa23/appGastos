
-- Private durable inbox/outbox; no conversation state or automatic catalog creation.
CREATE TABLE appgastos.whatsapp_messages (
 message_id text PRIMARY KEY CHECK(length(message_id) BETWEEN 1 AND 256),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 sender text NOT NULL CHECK(sender ~ '^[0-9]{8,15}$'),
 text_body text CHECK(text_body IS NULL OR length(text_body) BETWEEN 1 AND 4096),
 message_type text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed')),
 lease_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 expense_id uuid REFERENCES appgastos.expenses(id) ON DELETE SET NULL,
 outcome text CHECK(outcome IN ('registered','incomplete','unauthorized','unsupported','interpretation_error')),
 reply_text text,
 reply_state text NOT NULL DEFAULT 'pending' CHECK(reply_state IN ('pending','sending','sent','failed')),
 reply_lease_token uuid, reply_lease_until timestamptz,
 reply_attempts integer NOT NULL DEFAULT 0,
 reply_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text, completed_at timestamptz,
 CHECK(expense_id IS NULL OR outcome='registered')
);
REVOKE ALL ON appgastos.whatsapp_messages FROM PUBLIC;
ALTER TABLE appgastos.whatsapp_messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX whatsapp_messages_pending_idx ON appgastos.whatsapp_messages(next_attempt_at)
 WHERE state <> 'completed';
CREATE INDEX whatsapp_messages_reply_idx ON appgastos.whatsapp_messages(reply_next_attempt_at)
 WHERE state='completed' AND reply_state IN ('pending','sending');
