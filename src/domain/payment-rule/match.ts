/** Regelauswahl nach Zahlungseingang (rein, ohne DB). */
import { PAYMENT_SOURCES } from "@/schemas/payment-rule";

export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
export type RuleTrigger = "PAID_FULL" | "PAID_PARTIAL";

/** Quelle einer Zahlung: Anbieter schlaegt Erfasser; Scheduler und Benutzer gelten als manuell. */
export function paymentSource(createdBy: string, provider: string | null): PaymentSource {
  if (provider === "BANK" || provider === "MOLLIE" || provider === "STRIPE") return provider;
  if (createdBy === "api" || createdBy === "webhook") return "API";
  if (createdBy === "mcp") return "MCP";
  return "MANUAL";
}

/** Ausloeser aus dem Endstatus der Rechnung nach der Zahlung. */
export function triggerFor(finalStatus: string): RuleTrigger | null {
  if (finalStatus === "PAID") return "PAID_FULL";
  if (finalStatus === "PARTIALLY_PAID") return "PAID_PARTIAL";
  return null;
}

export interface RuleFacts {
  trigger: RuleTrigger;
  source: PaymentSource;
  invoiceTagIds: ReadonlySet<string>;
}

/** Liest die Quellenliste; null = alle, kaputt = leere Liste (trifft nie, Regel wird nie breiter). */
function parseSources(json: string | null): readonly string[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function matchRules<
  R extends {
    id: string;
    active: boolean;
    archivedAt: Date | null;
    trigger: string;
    sourcesJson: string | null;
    invoiceTagId: string | null;
    sortOrder: number;
    createdAt: Date;
  },
>(rules: readonly R[], facts: RuleFacts): R[] {
  return rules
    .filter((r) => {
      if (!r.active || r.archivedAt !== null) return false;
      if (r.trigger !== facts.trigger) return false;
      const sources = parseSources(r.sourcesJson);
      if (sources !== null && !sources.includes(facts.source)) return false;
      if (r.invoiceTagId !== null && !facts.invoiceTagIds.has(r.invoiceTagId)) return false;
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
