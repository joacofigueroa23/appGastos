
-- Tipo configurado de la tarjeta. NULL = sin definir: el gasto debe indicar crédito o débito.
-- No modifica tarjetas ni gastos existentes.
ALTER TABLE appgastos.cards ADD COLUMN card_type text
 CHECK(card_type IS NULL OR card_type IN ('credit_card','debit_card'));
