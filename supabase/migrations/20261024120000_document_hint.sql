-- Intención explícita del usuario al mandar un archivo («estos son mis presupuestos», «pagué el colegio»). Solo una etiqueta cerrada: no se guarda el texto.
-- Aditiva: columna nueva y opcional.
ALTER TABLE appgastos.documents ADD COLUMN intent_hint text CHECK(intent_hint IS NULL OR intent_hint IN ('budget','fixed','purchase','payment','invoice','statement'));
