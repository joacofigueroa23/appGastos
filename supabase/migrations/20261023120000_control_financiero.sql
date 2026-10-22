-- Fase 3: control financiero familiar. Aditiva y compatible: no modifica ni borra gastos, presupuestos ni obligaciones existentes.
--  * Categorías con un nivel de subcategorías.
--  * Presupuesto variable BASE recurrente (con vigencia desde un mes); las filas de appgastos.budgets pasan a ser EXCEPCIONES de un mes.
--  * Historial de importes de los gastos fijos (un cambio "desde diciembre" no toca meses anteriores).
--  * expense_lines distingue los pagos de obligaciones fijas (is_fixed) para que no consuman presupuestos variables.
--  * Acciones de administración pendientes de confirmación por WhatsApp.

-- ---- 3B: categorías y subcategorías (máximo dos niveles). Nunca se borran: se archivan con active=false.
ALTER TABLE appgastos.categories ADD COLUMN parent_id uuid;
ALTER TABLE appgastos.categories ADD CONSTRAINT categories_parent_fk FOREIGN KEY(family_id,parent_id) REFERENCES appgastos.categories(family_id,id) ON DELETE RESTRICT;
ALTER TABLE appgastos.categories ADD CONSTRAINT categories_parent_not_self CHECK(parent_id IS NULL OR parent_id <> id);
CREATE INDEX categories_parent_idx ON appgastos.categories(family_id,parent_id) WHERE parent_id IS NOT NULL;
-- Garantía en la base: el padre debe ser una categoría principal y una categoría con subcategorías no puede pasar a ser subcategoría.
CREATE FUNCTION appgastos.check_category_levels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.parent_id IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM appgastos.categories WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN RAISE EXCEPTION 'category_depth'; END IF;
  IF EXISTS (SELECT 1 FROM appgastos.categories WHERE parent_id = NEW.id) THEN RAISE EXCEPTION 'category_depth'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER categories_levels BEFORE INSERT OR UPDATE OF parent_id ON appgastos.categories
 FOR EACH ROW EXECUTE FUNCTION appgastos.check_category_levels();

-- ---- 3A: presupuesto variable base recurrente. El vigente para un mes es la fila más reciente con effective_from <= mes.
-- amount NULL = "sin presupuesto desde ese mes" (finaliza la base sin borrar el historial). Una fila de appgastos.budgets para ese mes
-- (categoría y moneda) es una excepción y tiene prioridad sobre la base. No hay proceso mensual: todo se calcula por período.
CREATE TABLE appgastos.budget_bases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 category_id uuid NOT NULL,
 currency text NOT NULL DEFAULT 'ARS' CHECK(currency ~ '^[A-Z]{3}$'),
 effective_from date NOT NULL CHECK(EXTRACT(day FROM effective_from) = 1),
 amount numeric(14,2) CHECK(amount IS NULL OR amount > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by_member_id uuid REFERENCES appgastos.family_members(id),
 FOREIGN KEY(family_id,category_id) REFERENCES appgastos.categories(family_id,id) ON DELETE RESTRICT,
 UNIQUE(family_id,category_id,currency,effective_from)
);
REVOKE ALL ON appgastos.budget_bases FROM PUBLIC;
ALTER TABLE appgastos.budget_bases ENABLE ROW LEVEL SECURITY;

-- ---- 3A: historial de importes de gastos fijos. Las obligaciones ya generadas conservan su importe; las nuevas toman el vigente a su período.
CREATE TABLE appgastos.fixed_expense_amounts (
 fixed_expense_id uuid NOT NULL,
 family_id uuid NOT NULL,
 effective_from date NOT NULL CHECK(EXTRACT(day FROM effective_from) = 1),
 amount numeric(14,2) NOT NULL CHECK(amount > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(fixed_expense_id,effective_from),
 FOREIGN KEY(family_id,fixed_expense_id) REFERENCES appgastos.fixed_expenses(family_id,id) ON DELETE CASCADE
);
REVOKE ALL ON appgastos.fixed_expense_amounts FROM PUBLIC;
ALTER TABLE appgastos.fixed_expense_amounts ENABLE ROW LEVEL SECURITY;
-- Punto de partida: el importe actual rige desde el mes de inicio. No cambia ningún importe ya generado ni futuro.
INSERT INTO appgastos.fixed_expense_amounts(fixed_expense_id,family_id,effective_from,amount)
 SELECT id, family_id, (start_date - (EXTRACT(day FROM start_date)::int - 1)), expected_amount FROM appgastos.fixed_expenses;

-- ---- 3A/3C: un gasto que paga una obligación fija (vinculado a una ocurrencia) NO consume presupuestos variables.
CREATE OR REPLACE VIEW appgastos.expense_lines AS
 SELECT e.id AS expense_id, e.family_id, e.date, e.currency, e.reported_by_member_id, e.scope, i.category_id, i.amount,
  EXISTS (SELECT 1 FROM appgastos.fixed_expense_occurrences o WHERE o.expense_id = e.id) AS is_fixed
  FROM appgastos.expenses e JOIN appgastos.expense_items i ON i.expense_id = e.id
 UNION ALL
 SELECT e.id, e.family_id, e.date, e.currency, e.reported_by_member_id, e.scope, e.category_id, e.amount,
  EXISTS (SELECT 1 FROM appgastos.fixed_expense_occurrences o WHERE o.expense_id = e.id)
  FROM appgastos.expenses e WHERE NOT EXISTS (SELECT 1 FROM appgastos.expense_items i WHERE i.expense_id = e.id);

-- ---- 3D: acciones de administración que el bot propone y el administrador confirma. Una pendiente por administrador.
CREATE TABLE appgastos.admin_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 member_id uuid NOT NULL,
 short_code text NOT NULL CHECK(short_code ~ '^[A-Z0-9]{4}$'),
 action jsonb NOT NULL,
 summary text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','cancelled','expired')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 confirmed_at timestamptz,
 FOREIGN KEY(family_id,member_id) REFERENCES appgastos.family_members(family_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX admin_actions_one_pending ON appgastos.admin_actions(family_id,member_id) WHERE state = 'pending';
CREATE UNIQUE INDEX admin_actions_open_code ON appgastos.admin_actions(family_id,short_code) WHERE state = 'pending';
REVOKE ALL ON appgastos.admin_actions FROM PUBLIC;
ALTER TABLE appgastos.admin_actions ENABLE ROW LEVEL SECURITY;

ALTER TABLE appgastos.whatsapp_messages DROP CONSTRAINT whatsapp_messages_outcome_check;
ALTER TABLE appgastos.whatsapp_messages ADD CONSTRAINT whatsapp_messages_outcome_check CHECK(outcome IN
 ('registered','incomplete','unauthorized','unsupported','interpretation_error',
  'question','corrected','cancelled','pending_conflict','nothing_to_cancel','unrecognized',
  'linked','link_failed','query','query_denied',
  'document_received','document_rejected','document_ready','document_failed','document_command',
  'admin_config','admin_denied'));
