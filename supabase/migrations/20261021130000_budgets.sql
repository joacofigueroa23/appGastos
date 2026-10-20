-- Fase 1C: presupuestos mensuales por categoría. Aditiva. Los presupuestos nunca crean gastos:
-- el consumo se calcula siempre sobre appgastos.expenses (fecha, categoría, moneda).
CREATE TABLE appgastos.budgets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 category_id uuid NOT NULL,
 month date NOT NULL CHECK(EXTRACT(day FROM month)=1),
 currency text NOT NULL DEFAULT 'ARS' CHECK(currency ~ '^[A-Z]{3}$'),
 amount numeric(14,2) NOT NULL CHECK(amount > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_member_id uuid REFERENCES appgastos.family_members(id),
 FOREIGN KEY(family_id,category_id) REFERENCES appgastos.categories(family_id,id) ON DELETE RESTRICT,
 UNIQUE(family_id,category_id,month,currency)
);
CREATE INDEX budgets_family_month_idx ON appgastos.budgets(family_id,month);
REVOKE ALL ON appgastos.budgets FROM PUBLIC;
ALTER TABLE appgastos.budgets ENABLE ROW LEVEL SECURITY;
