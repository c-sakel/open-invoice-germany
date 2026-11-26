import { z } from "zod";

// Die Content-Security-Policy erlaubt kein 'unsafe-eval'. Zod prueft sonst per `Function("")`, ob es
// Validierer zur Laufzeit uebersetzen darf, und loest damit in jedem Browser eine CSP-Meldung aus
// (das Ergebnis waere "nicht erlaubt", Zod faellt dann ohnehin auf den normalen Pfad zurueck).
// Diese Datei laeuft vor jedem anderen Client-Code und schaltet die Pruefung vorab ab.
z.config({ jitless: true });
