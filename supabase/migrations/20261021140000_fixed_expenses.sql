-- Fase 1D-b: gastos fijos (obligaciones recurrentes) y sus ocurrencias mensuales. Aditiva.
-- Una obligación prevista NUNCA es un gasto: solo un gasto real (expenses) vinculado la marca como pagada.
CREATE TABLE appgastos.fixed_expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 category_id uuid NOT NULL,
 expected_amount numeric(14,2) NOT NULL CHECK(expected_amount > 0),
 currency text NOT NULL DEFAULT 'ARS' CHECK(currency ~ '^[A-Z]{3}$'),
 frequency text NOT NULL DEFAULT 'monthly' CHECK(frequency IN ('monthly')),
 start_date date NOT NULL,
 due_day smallint NOT NULL CHECK(due_day BETWEEN 1 AND 31),
 end_date date CHECK(end_date IS NULL OR end_date >= start_date),
 installments_total integer CHECK(installments_total IS NULL OR installments_total > 0),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(family_id,category_id) REFERENCES appgastos.categories(family_id,id) ON DELETE RESTRICT,
 UNIQUE(family_id,id)
);
-- Una fila por obligación y mes. Se crean al consultar el período (sin proceso en segundo plano). expected_amount es una
-- copia del importe vigente al crearla: cambiar la obligación después no reescribe lo ya pagado.
-- Pagada = tiene expense_id (un gasto no puede pagar dos ocurrencias). Vencida = sin pagar y due_date pasada (se calcula).
CREATE TABLE appgastos.fixed_expense_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL,
 fixed_expense_id uuid NOT NULL,
 period date NOT NULL CHECK(EXTRACT(day FROM period)=1),
 due_date date NOT NULL,
 expected_amount numeric(14,2) NOT NULL CHECK(expected_amount > 0),
 installment_number integer CHECK(installment_number IS NULL OR installment_number > 0),
 expense_id uuid UNIQUE REFERENCES appgastos.expenses(id) ON DELETE SET NULL,
 -- auto: vinculado por coincidencia segura (se revalida si el gasto cambia); manual: decidido por un administrador.
 -- Solo vale mientras expense_id no sea NULL (si se borra el gasto, expense_id vuelve a NULL por la clave foránea).
 link_source text CHECK(link_source IS NULL OR link_source IN ('auto','manual')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(family_id,fixed_expense_id) REFERENCES appgastos.fixed_expenses(family_id,id) ON DELETE RESTRICT,
 UNIQUE(fixed_expense_id,period)
);
CREATE INDEX fixed_occurrences_family_period_idx ON appgastos.fixed_expense_occurrences(family_id,period);
REVOKE ALL ON appgastos.fixed_expenses FROM PUBLIC;
REVOKE ALL ON appgastos.fixed_expense_occurrences FROM PUBLIC;
ALTER TABLE appgastos.fixed_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE appgastos.fixed_expense_occurrences ENABLE ROW LEVEL SECURITY;
