-- Bot V3: reglas de categoría aprendidas. Aditiva: tabla nueva, no toca datos existentes.
-- Una regla nace SOLO de una categoría que el usuario eligió o corrigió de forma explícita y confirmó (nunca de una suposición del modelo).
--  * member_id NULL = regla de la familia (la creó un gasto de la casa); con member_id = regla personal de ese integrante.
--  * key = nombre del comercio normalizado (sin acentos ni símbolos). No se guarda texto del comprobante ni datos de pago.
CREATE TABLE appgastos.category_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 family_id uuid NOT NULL,
 member_id uuid,
 key text NOT NULL CHECK(length(key) BETWEEN 3 AND 80),
 category_id uuid NOT NULL,
 hits integer NOT NULL DEFAULT 1 CHECK(hits >= 1),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(family_id,category_id) REFERENCES appgastos.categories(family_id,id) ON DELETE CASCADE,
 FOREIGN KEY(member_id) REFERENCES appgastos.family_members(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX category_rules_unique ON appgastos.category_rules(family_id,COALESCE(member_id,'00000000-0000-0000-0000-000000000000'::uuid),key);
CREATE INDEX category_rules_lookup ON appgastos.category_rules(family_id,key);
ALTER TABLE appgastos.category_rules ENABLE ROW LEVEL SECURITY;
