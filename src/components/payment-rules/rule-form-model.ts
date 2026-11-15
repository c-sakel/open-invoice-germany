/** Formularmodell der Regeln nach Zahlungseingang: Zustand -> Eingabe (Zod), deutsche Fehlertexte, Labels. Rein. */
import { paymentRuleInputSchema, PAYMENT_SOURCES, type PaymentRuleAction, type PaymentRuleInput } from "@/schemas/payment-rule";

export const PAYMENT_CONFIRMATION_TEMPLATE_TYPE = "PAYMENT_CONFIRMATION";

export const SOURCE_LABELS: Record<(typeof PAYMENT_SOURCES)[number], string> = {
  MANUAL: "Manuell erfasst", API: "REST-Schnittstelle", MCP: "MCP", BANK: "Bankabgleich", MOLLIE: "Online (Mollie)", STRIPE: "Online (Stripe)",
};
export const TRIGGER_LABELS = { PAID_FULL: "Vollständig bezahlt", PAID_PARTIAL: "Teilweise bezahlt" } as const;
export const ACTION_LABELS: Record<PaymentRuleAction["type"], string> = {
  SEND_PAYMENT_CONFIRMATION: "Zahlungsbestätigung per Mail",
  ADD_TAG: "Tag setzen",
  NOTIFY: "Benachrichtigung anlegen",
  EMIT_WEBHOOK: "Webhook senden",
  RESUME_RECURRING: "Pausierte Abos fortsetzen",
};
export const RUN_STATUS_LABELS: Record<string, string> = {
  PENDING: "geplant", RUNNING: "läuft", DONE: "erledigt", FAILED: "fehlgeschlagen", SKIPPED: "übersprungen",
};
export const STEP_STATUS_LABELS: Record<string, string> = { PENDING: "offen", DONE: "erledigt", SKIPPED: "übersprungen", FAILED: "fehlgeschlagen" };

export interface RuleFormState {
  name: string;
  active: boolean;
  trigger: "PAID_FULL" | "PAID_PARTIAL";
  allSources: boolean;
  sources: string[];
  invoiceTagId: string;
  delayMinutes: string;
  sortOrder: number;
  confirm: { on: boolean; templateId: string };
  tag: { on: boolean; tagId: string };
  notify: { on: boolean; note: string };
  webhook: { on: boolean };
  resume: { on: boolean; missedPeriods: "SKIP" | "BILL" };
}

export function emptyRuleFormState(): RuleFormState {
  return {
    name: "", active: true, trigger: "PAID_FULL", allSources: true, sources: [], invoiceTagId: "", delayMinutes: "5", sortOrder: 0,
    confirm: { on: false, templateId: "" }, tag: { on: false, tagId: "" }, notify: { on: false, note: "" },
    webhook: { on: false }, resume: { on: false, missedPeriods: "SKIP" },
  };
}

export function ruleToFormState(rule: PaymentRuleInput): RuleFormState {
  const s = emptyRuleFormState();
  s.name = rule.name; s.active = rule.active; s.trigger = rule.trigger;
  s.allSources = rule.sources === null; s.sources = rule.sources ?? [];
  s.invoiceTagId = rule.invoiceTagId ?? ""; s.delayMinutes = String(rule.delayMinutes); s.sortOrder = rule.sortOrder;
  for (const a of rule.actions) {
    if (a.type === "SEND_PAYMENT_CONFIRMATION") s.confirm = { on: true, templateId: a.templateId ?? "" };
    else if (a.type === "ADD_TAG") s.tag = { on: true, tagId: a.tagId };
    else if (a.type === "NOTIFY") s.notify = { on: true, note: a.note ?? "" };
    else if (a.type === "EMIT_WEBHOOK") s.webhook = { on: true };
    else s.resume = { on: true, missedPeriods: a.missedPeriods };
  }
  return s;
}

export function formStateToRaw(s: RuleFormState): unknown {
  const actions: unknown[] = [];
  if (s.confirm.on) actions.push({ type: "SEND_PAYMENT_CONFIRMATION", templateId: s.confirm.templateId === "" ? null : s.confirm.templateId });
  if (s.tag.on) actions.push({ type: "ADD_TAG", tagId: s.tag.tagId });
  if (s.notify.on) actions.push({ type: "NOTIFY", ...(s.notify.note.trim() === "" ? {} : { note: s.notify.note }) });
  if (s.webhook.on) actions.push({ type: "EMIT_WEBHOOK" });
  if (s.resume.on) actions.push({ type: "RESUME_RECURRING", missedPeriods: s.resume.missedPeriods });
  return {
    name: s.name, active: s.active, trigger: s.trigger,
    sources: s.allSources ? null : s.sources,
    invoiceTagId: s.invoiceTagId === "" ? null : s.invoiceTagId,
    delayMinutes: s.delayMinutes.trim() === "" ? Number.NaN : Number(s.delayMinutes),
    actions, sortOrder: s.sortOrder,
  };
}

interface IssueLike { path: readonly PropertyKey[]; message: string; code: string }

/** Deutscher Text zu einem Zod-Befund der Regel-Eingabe (die Standardtexte der Bibliothek sind englisch). */
export function ruleIssueText(issue: IssueLike): string {
  const [head, , leaf] = issue.path;
  if (issue.code === "custom") return issue.message;
  switch (head) {
    case "name": return "Bitte einen Namen mit 1 bis 100 Zeichen ohne Steuerzeichen eingeben.";
    case "trigger": return "Bitte einen Auslöser wählen.";
    case "sources": return "Bitte mindestens eine Quelle wählen oder „Alle Quellen“ einschalten.";
    case "invoiceTagId": return "Bitte einen gültigen Tag für den Filter wählen.";
    case "delayMinutes": return "Wartezeit: bitte ganze Minuten von 0 bis 1440 eingeben.";
    case "sortOrder": return "Die Reihenfolge muss eine ganze Zahl von 0 bis 999 sein.";
    case "actions":
      if (leaf === "tagId") return "Bitte einen Tag für die Aktion „Tag setzen“ wählen.";
      if (leaf === "note") return "Die Notiz darf höchstens 300 Zeichen lang sein und keine Steuerzeichen enthalten.";
      if (leaf === "templateId") return "Bitte eine gültige Mailvorlage wählen.";
      return "Bitte mindestens eine Aktion wählen (höchstens fünf).";
    default: return "Ungültige Eingabe.";
  }
}

export function validateRuleForm(s: RuleFormState): { ok: true; input: PaymentRuleInput } | { ok: false; error: string } {
  const parsed = paymentRuleInputSchema.safeParse(formStateToRaw(s));
  if (parsed.success) return { ok: true, input: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, error: first ? ruleIssueText(first) : "Ungültige Eingabe." };
}

/** Ein manueller Retry nach unklarem Versand ist ein Folgeversand: die erste Mail kann schon zugestellt sein. Scheiterte der Versand sicher vorher, gilt das nicht. */
export function isMailFollowUp(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s: unknown) => typeof s === "object" && s !== null && "type" in s && "status" in s && s.type === "SEND_PAYMENT_CONFIRMATION" && s.status === "FAILED" && "error" in s && typeof s.error === "string" && s.error.includes("Versand unklar"));
}
