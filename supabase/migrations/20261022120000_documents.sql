-- Fase 2: comprobantes (imágenes y PDF) recibidos por WhatsApp. Aditiva: no modifica ni borra gastos existentes.
-- Un comprobante leído NUNCA es un gasto pagado: solo propone. Los movimientos se crean al confirmar.

-- Datos del medio de un mensaje entrante (id de Meta, tipo declarado, sha256, nombre). No contiene el archivo.
ALTER TABLE appgastos.whatsapp_messages ADD COLUMN media jsonb;
ALTER TABLE appgastos.whatsapp_messages DROP CONSTRAINT whatsapp_messages_outcome_check;
ALTER TABLE appgastos.whatsapp_messages ADD CONSTRAINT whatsapp_messages_outcome_check CHECK(outcome IN
 ('registered','incomplete','unauthorized','unsupported','interpretation_error',
  'question','corrected','cancelled','pending_conflict','nothing_to_cancel','unrecognized',
  'linked','link_failed','query','query_denied',
  'document_received','document_rejected','document_ready','document_failed','document_command'));

-- Cada documento recibido y su proceso. Los archivos NO se guardan: se descargan de Meta, se leen y se descartan.
-- extraction = lo que el modelo leyó (validado); draft = propuesta editable; result = lo registrado al confirmar.
-- Al confirmar, cancelar, fallar o vencer, extraction y draft se vacían (retención mínima).
CREATE TABLE appgastos.documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 member_id uuid NOT NULL,
 -- sender es el teléfono de WhatsApp; NULL en los comprobantes subidos desde la web (no hay a quién responder por chat).
 sender text CHECK(sender IS NULL OR sender ~ '^[0-9]{8,15}$'),
 short_code text NOT NULL CHECK(short_code ~ '^[A-Z0-9]{4}$'),
 source_message_id text UNIQUE REFERENCES appgastos.whatsapp_messages(message_id) ON DELETE SET NULL,
 media_id text NOT NULL CHECK(length(media_id) BETWEEN 1 AND 256),
 media_mime text NOT NULL CHECK(length(media_mime) <= 100),
 media_sha256 text CHECK(media_sha256 IS NULL OR length(media_sha256) <= 128),
 filename text CHECK(filename IS NULL OR length(filename) <= 255),
 household_hint boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','processing','needs_review','confirmed','cancelled','failed')),
 kind text CHECK(kind IS NULL OR kind IN ('purchase_receipt','pending_invoice','payment_receipt','card_statement','unknown')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz,
 extraction jsonb, draft jsonb, result jsonb, usage jsonb,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_:]{1,80}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 confirmed_at timestamptz,
 FOREIGN KEY(family_id,member_id) REFERENCES appgastos.family_members(family_id,id) ON DELETE RESTRICT
);
-- El mismo archivo (según Meta) del mismo integrante no se procesa dos veces mientras esté en curso o confirmado.
CREATE UNIQUE INDEX documents_no_repeat ON appgastos.documents(family_id,member_id,media_sha256)
 WHERE media_sha256 IS NOT NULL AND state IN ('received','processing','needs_review','confirmed');
-- El código corto identifica el borrador en las confirmaciones por WhatsApp: único entre los abiertos de la familia.
CREATE UNIQUE INDEX documents_open_code ON appgastos.documents(family_id,short_code) WHERE state IN ('received','processing','needs_review');
CREATE INDEX documents_work_idx ON appgastos.documents(next_attempt_at) WHERE state IN ('received','processing');
CREATE INDEX documents_member_idx ON appgastos.documents(family_id,member_id,created_at DESC);
REVOKE ALL ON appgastos.documents FROM PUBLIC;
ALTER TABLE appgastos.documents ENABLE ROW LEVEL SECURITY;

-- Conceptos de un gasto con varias categorías (ticket de supermercado). Un gasto sin conceptos sigue computándose por su
-- categoría y su importe, como siempre. Con conceptos, la suma de los conceptos DEBE ser igual al importe del gasto.
CREATE TABLE appgastos.expense_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 expense_id uuid NOT NULL REFERENCES appgastos.expenses(id) ON DELETE CASCADE,
 family_id uuid NOT NULL,
 position smallint NOT NULL CHECK(position >= 0),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 300),
 category_id uuid NOT NULL,
 amount numeric(14,2) NOT NULL CHECK(amount <> 0),
 FOREIGN KEY(family_id,category_id) REFERENCES appgastos.categories(family_id,id) ON DELETE RESTRICT,
 UNIQUE(expense_id,position)
);
CREATE INDEX expense_items_category_idx ON appgastos.expense_items(family_id,category_id);
REVOKE ALL ON appgastos.expense_items FROM PUBLIC;
ALTER TABLE appgastos.expense_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE appgastos.expenses ADD COLUMN document_id uuid REFERENCES appgastos.documents(id) ON DELETE SET NULL;
-- Compra en cuotas registrada al inicio por su importe total (decisión aprobada): se guarda en cuántos meses se paga.
ALTER TABLE appgastos.expenses ADD COLUMN installments smallint CHECK(installments IS NULL OR installments BETWEEN 2 AND 120);
-- Devoluciones: restan del gasto original (decisión aprobada). amount ya es el neto; refunded_amount deja a la vista cuánto se devolvió.
ALTER TABLE appgastos.expenses ADD COLUMN refunded_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(refunded_amount >= 0);
CREATE INDEX expenses_document_idx ON appgastos.expenses(document_id) WHERE document_id IS NOT NULL;

-- Garantía en la base: no puede quedar un gasto con conceptos cuya suma no sea su importe (se comprueba al cerrar la transacción).
CREATE FUNCTION appgastos.check_items_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; n integer; total numeric; amt numeric;
BEGIN
 IF TG_TABLE_NAME = 'expense_items' THEN eid := COALESCE(NEW.expense_id, OLD.expense_id); ELSE eid := NEW.id; END IF;
 SELECT count(*), COALESCE(sum(amount),0) INTO n, total FROM appgastos.expense_items WHERE expense_id = eid;
 IF n > 0 THEN
  SELECT amount INTO amt FROM appgastos.expenses WHERE id = eid;
  IF amt IS NOT NULL AND amt <> total THEN RAISE EXCEPTION 'items_total_mismatch'; END IF;
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER expense_items_total AFTER INSERT OR UPDATE OR DELETE ON appgastos.expense_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appgastos.check_items_total();
CREATE CONSTRAINT TRIGGER expenses_items_total AFTER UPDATE OF amount ON appgastos.expenses
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appgastos.check_items_total();

-- Una sola definición de "cuánto consume cada categoría": los conceptos si el gasto los tiene; si no, el gasto entero.
-- Presupuestos y consultas leen de acá; así nunca se suma a la vez el total y sus conceptos.
CREATE VIEW appgastos.expense_lines AS
 SELECT e.id AS expense_id, e.family_id, e.date, e.currency, e.reported_by_member_id, e.scope, i.category_id, i.amount
  FROM appgastos.expenses e JOIN appgastos.expense_items i ON i.expense_id = e.id
 UNION ALL
 SELECT e.id, e.family_id, e.date, e.currency, e.reported_by_member_id, e.scope, e.category_id, e.amount
  FROM appgastos.expenses e WHERE NOT EXISTS (SELECT 1 FROM appgastos.expense_items i WHERE i.expense_id = e.id);
REVOKE ALL ON appgastos.expense_lines FROM PUBLIC;
