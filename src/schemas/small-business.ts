/**
 * Kleinunternehmerregelung (§ 19 UStG): Abfrage der Umsatzgrenzen und Hinweistext. Gemeinsame
 * Quelle fuer REST, MCP und Benachrichtigung.
 */
import { z } from "zod";

export const KU_NOTICE =
  "Hinweis zur Orientierung, keine steuerliche Beratung: Grundlage sind die vereinnahmten Entgelte (netto); berechnete Umsätze dienen nur als Vorwarnung. Umsätze außerhalb dieses Programms tragen Sie in den Einstellungen ein; das Steuerschema wird nie automatisch umgestellt.";

export const kuQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2099).optional() });
