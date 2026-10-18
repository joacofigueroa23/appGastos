-- Cuentas individuales: cada integrante (family_members) puede tener una cuenta de Supabase Auth
-- y un WhatsApp verificado. Aditiva: no borra ni reescribe filas; el backend anterior sigue funcionando.
-- La autoría de un gasto sigue siendo expenses.reported_by_member_id (NULL = histórico sin autor).

-- Identidad: una cuenta pertenece como máximo a un integrante. NULL = integrante sin acceso web.
ALTER TABLE appgastos.family_members ADD COLUMN auth_user_id uuid UNIQUE;
-- En Supabase, borrar la cuenta desvincula al integrante pero conserva sus gastos.
DO $$
BEGIN
 IF to_regclass('auth.users') IS NOT NULL THEN
  ALTER TABLE appgastos.family_members
   ADD CONSTRAINT family_members_auth_user_fk FOREIGN KEY(auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
 END IF;
END $$;

-- Un número activo no puede pertenecer a dos integrantes (se compara ya normalizado, igual que el bot).
CREATE UNIQUE INDEX family_members_active_phone_uidx ON appgastos.family_members
 (family_id, (regexp_replace(phone_number,'[\s()+\-]','','g'))) WHERE active AND phone_number IS NOT NULL;

-- Códigos de vinculación de WhatsApp: temporales y de un solo uso; solo se guarda el hash.
CREATE TABLE appgastos.whatsapp_link_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL,
 member_id uuid NOT NULL,
 code_hash text NOT NULL UNIQUE CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(family_id,member_id) REFERENCES appgastos.family_members(family_id,id) ON DELETE CASCADE
);
-- Como máximo un código sin usar por integrante.
CREATE UNIQUE INDEX whatsapp_link_codes_one_open ON appgastos.whatsapp_link_codes(member_id) WHERE used_at IS NULL;

ALTER TABLE appgastos.whatsapp_messages DROP CONSTRAINT whatsapp_messages_outcome_check;
ALTER TABLE appgastos.whatsapp_messages ADD CONSTRAINT whatsapp_messages_outcome_check CHECK(outcome IN
 ('registered','incomplete','unauthorized','unsupported','interpretation_error',
  'question','corrected','cancelled','pending_conflict','nothing_to_cancel','unrecognized',
  'linked','link_failed'));
-- Cuenta de intentos fallidos de vinculación por remitente.
CREATE INDEX whatsapp_messages_link_failed_idx ON appgastos.whatsapp_messages(family_id,sender,completed_at) WHERE outcome='link_failed';

-- Defensa en profundidad: ninguna tabla queda legible por los roles de la Data API de Supabase.
-- El backend conecta como propietario de las tablas, que no queda sujeto a RLS.
REVOKE ALL ON appgastos.whatsapp_link_codes FROM PUBLIC;
ALTER TABLE appgastos.whatsapp_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE appgastos.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE appgastos.family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE appgastos.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE appgastos.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE appgastos.expenses ENABLE ROW LEVEL SECURITY;
