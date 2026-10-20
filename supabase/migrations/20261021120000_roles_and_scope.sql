-- Fase 1A (roles) y 1D-a (ámbito personal/casa). Aditiva: no borra ni reescribe gastos.
-- Hasta que se designe un administrador (npm run db:member-account -- set-role), todos los integrantes son 'member'.

ALTER TABLE appgastos.family_members
 ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
 ADD COLUMN role_changed_at timestamptz,
 ADD COLUMN role_changed_by_member_id uuid REFERENCES appgastos.family_members(id);

-- Nunca puede quedar una familia sin administrador activo una vez que tuvo uno.
-- El bloqueo de asesor serializa dos cambios simultáneos (dos admins que se degradan entre sí).
CREATE FUNCTION appgastos.keep_one_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.role='admin' AND OLD.active AND (NEW.role<>'admin' OR NOT NEW.active) THEN
  PERFORM pg_advisory_xact_lock(hashtext('appgastos.admin.'||OLD.family_id::text));
  IF NOT EXISTS(SELECT 1 FROM appgastos.family_members WHERE family_id=OLD.family_id AND id<>OLD.id AND role='admin' AND active) THEN
   RAISE EXCEPTION 'last_admin';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER family_members_keep_admin BEFORE UPDATE OF role,active ON appgastos.family_members
FOR EACH ROW EXECUTE FUNCTION appgastos.keep_one_admin();

-- Ámbito del gasto. NULL = sin clasificar (histórico): nunca se infiere por descripción ni categoría.
ALTER TABLE appgastos.expenses ADD COLUMN scope text CHECK(scope IS NULL OR scope IN ('personal','household'));

-- Resultados nuevos del bot: consulta respondida o negada por permisos.
ALTER TABLE appgastos.whatsapp_messages DROP CONSTRAINT whatsapp_messages_outcome_check;
ALTER TABLE appgastos.whatsapp_messages ADD CONSTRAINT whatsapp_messages_outcome_check CHECK(outcome IN
 ('registered','incomplete','unauthorized','unsupported','interpretation_error',
  'question','corrected','cancelled','pending_conflict','nothing_to_cancel','unrecognized',
  'linked','link_failed','query','query_denied'));
