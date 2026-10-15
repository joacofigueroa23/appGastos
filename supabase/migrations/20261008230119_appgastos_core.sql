CREATE SCHEMA appgastos;
REVOKE ALL ON SCHEMA appgastos FROM PUBLIC;
CREATE TABLE appgastos.schema_migrations (
 name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appgastos.families (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 default_currency text NOT NULL DEFAULT 'ARS' CHECK (default_currency ~ '^[A-Z]{3}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE appgastos.family_members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 phone_number text, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(family_id,id)
);
CREATE TABLE appgastos.categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(family_id,id), UNIQUE(family_id,name)
);
CREATE TABLE appgastos.cards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(family_id,id), UNIQUE(family_id,name)
);
CREATE TABLE appgastos.expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL REFERENCES appgastos.families(id) ON DELETE RESTRICT,
 date date NOT NULL CHECK (date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 amount numeric(14,2) NOT NULL CHECK (amount > 0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 merchant text CHECK(merchant IS NULL OR length(btrim(merchant)) BETWEEN 1 AND 200),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),
 category_id uuid NOT NULL,
 payment_method text NOT NULL CHECK(payment_method IN ('cash','debit_card','credit_card','transfer','wallet','other')),
 card_id uuid, reported_by_member_id uuid,
 source text NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','whatsapp')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(family_id,category_id) REFERENCES appgastos.categories(family_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(family_id,card_id) REFERENCES appgastos.cards(family_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(family_id,reported_by_member_id) REFERENCES appgastos.family_members(family_id,id) ON DELETE RESTRICT,
 CHECK(card_id IS NULL OR payment_method IN ('debit_card','credit_card'))
);
CREATE INDEX expenses_family_date_idx ON appgastos.expenses(family_id,date DESC,created_at DESC,id);
CREATE INDEX expenses_category_idx ON appgastos.expenses(family_id,category_id);
CREATE INDEX expenses_card_idx ON appgastos.expenses(family_id,card_id) WHERE card_id IS NOT NULL;
CREATE INDEX expenses_member_idx ON appgastos.expenses(family_id,reported_by_member_id) WHERE reported_by_member_id IS NOT NULL;
CREATE FUNCTION appgastos.touch_expense_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END;
$$;
CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON appgastos.expenses
FOR EACH ROW EXECUTE FUNCTION appgastos.touch_expense_updated_at();
