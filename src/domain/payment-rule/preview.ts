/**
 * Trockenlauf einer Regel gegen eine Rechnung. Rein lesend: kein Protokoll, keine Mail, kein Tag,
 * keine Benachrichtigung, kein Statuswechsel, keine Outbox-Zeile. Grundlage ist die juengste aktive
 * Primaerzahlung der Rechnung; ohne Zahlung wird eine Vollzahlung des offenen Rests (Quelle MANUAL) angenommen.
 */
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { payableBaseCents } from "@/domain/invoice/amounts";
import { paymentRuleInputSchema, type PaymentRuleInput } from "@/schemas/payment-rule";
import { getPaymentRule } from "./rules";
import { matchRules, paymentSource, triggerFor, type PaymentSource } from "./match";
import { buildPaymentConfirmation } from "./mail";

export interface PaymentRulePreview {
  matches: boolean;
  reasons: string[];
  trigger: string | null;
  source: string | null;
  steps: { type: string; outcome: string; mail?: { to: string | null; subject: string; body: string } }[];
}

const INVOICE_SELECT = {
  id: true, number: true, status: true, currency: true, grossTotalCents: true, payableCents: true, paidAmountCents: true,
} as const;

export async function previewPaymentRule(orgId: string, ruleIdOrInput: string | unknown, invoiceId: string): Promise<PaymentRulePreview> {
  const invoice = await dbInternal.invoice.findFirst({ where: { id: invoiceId, orgId }, select: INVOICE_SELECT });
  if (!invoice) throw new NotFoundError("Rechnung nicht gefunden.");

  let rule: PaymentRuleInput;
  if (typeof ruleIdOrInput === "string") {
    const view = await getPaymentRule(orgId, ruleIdOrInput);
    rule = {
      name: view.name, active: view.active, trigger: view.trigger, sources: view.sources, invoiceTagId: view.invoiceTagId,
      delayMinutes: view.delayMinutes, actions: view.actions, sortOrder: view.sortOrder,
    };
  } else {
    rule = paymentRuleInputSchema.parse(ruleIdOrInput);
  }

  // Juengste aktive Primaerzahlung: keine Gegenbuchung, keine Skontozahlung, nicht gegengebucht.
  const payments = await dbInternal.payment.findMany({
    where: { invoiceId, invoice: { orgId }, kind: "PAYMENT", isSkonto: false },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { id: true, amountCents: true, paidAt: true, method: true, createdBy: true, provider: true },
  });
  const reversed = new Set(
    (await dbInternal.payment.findMany({ where: { invoiceId, invoice: { orgId }, kind: "REVERSAL" }, select: { reversesPaymentId: true } }))
      .map((r) => r.reversesPaymentId)
      .filter((x): x is string => x !== null),
  );
  const latest = payments.find((p) => !reversed.has(p.id)) ?? null;

  const base = payableBaseCents(invoice);
  const open = base - invoice.paidAmountCents;
  const assumed = latest === null;
  const amountCents = latest ? latest.amountCents : Math.max(open, 0);
  const finalStatus = assumed ? "PAID" : invoice.status;
  const source: PaymentSource = latest ? paymentSource(latest.createdBy, latest.provider) : "MANUAL";
  const trigger = triggerFor(finalStatus);
  const reasons: string[] = [];
  if (assumed) reasons.push("Keine Zahlung vorhanden: Vollzahlung des offenen Rests (Quelle MANUAL) angenommen.");

  const tagRows = await dbInternal.documentTag.findMany({ where: { orgId, docType: "INVOICE", docId: invoiceId }, select: { tagId: true } });
  const matched = trigger === null
    ? []
    : matchRules(
        [{
          id: "preview", active: true, archivedAt: null, trigger: rule.trigger,
          sourcesJson: rule.sources === null ? null : JSON.stringify(rule.sources),
          invoiceTagId: rule.invoiceTagId, sortOrder: 0, createdAt: new Date(0),
        }],
        { trigger, source, invoiceTagIds: new Set(tagRows.map((t) => t.tagId)) },
      );
  let matches = matched.length === 1;
  if (trigger === null) {
    reasons.push("Die Rechnung ist weder vollstaendig noch teilweise bezahlt.");
  } else if (!matches) {
    if (rule.trigger !== trigger) reasons.push(`Ausloeser passt nicht: Regel ${rule.trigger}, Rechnung ${trigger}.`);
    if (rule.sources !== null && !rule.sources.includes(source)) reasons.push(`Quelle ${source} ist nicht zugelassen.`);
    if (rule.invoiceTagId !== null && !tagRows.some((t) => t.tagId === rule.invoiceTagId)) reasons.push("Die Rechnung traegt den geforderten Tag nicht.");
  }
  if (matches && !rule.active) {
    matches = false;
    reasons.push("Die Regel ist nicht aktiv.");
  }

  const steps: PaymentRulePreview["steps"] = [];
  const paidAt = latest ? latest.paidAt : new Date();
  const openAfter = assumed ? 0 : open;
  for (const action of rule.actions) {
    switch (action.type) {
      case "SEND_PAYMENT_CONFIRMATION": {
        const res = await buildPaymentConfirmation(
          orgId, invoiceId,
          { amountCents, paidAt: paidAt.toISOString(), openAfterCents: openAfter, currency: invoice.currency, invoiceNumber: invoice.number },
          latest?.method ?? null, action.templateId,
        );
        steps.push(res.ok
          ? { type: action.type, outcome: `Mail an ${res.built.to}`, mail: { to: res.built.to, subject: res.built.subject, body: res.built.text } }
          : { type: action.type, outcome: `wuerde uebersprungen: ${res.note}`, mail: { to: null, subject: "", body: "" } });
        break;
      }
      case "ADD_TAG": {
        const tag = await dbInternal.tag.findFirst({ where: { id: action.tagId, orgId }, select: { name: true } });
        const set = tagRows.some((t) => t.tagId === action.tagId);
        steps.push({ type: action.type, outcome: !tag ? "wuerde uebersprungen: Tag geloescht" : set ? `Tag ${tag.name} bereits gesetzt` : `Tag ${tag.name} wuerde gesetzt` });
        break;
      }
      case "NOTIFY":
        steps.push({ type: action.type, outcome: "Benachrichtigung wuerde angelegt" });
        break;
      case "EMIT_WEBHOOK":
        steps.push({ type: action.type, outcome: "Webhook payment_rule.triggered wuerde eingereiht" });
        break;
      case "RESUME_RECURRING":
        steps.push({ type: action.type, outcome: action.missedPeriods === "BILL" ? "Pausierte Abos wuerden fortgesetzt (verpasste Perioden nachberechnet)" : "Pausierte Abos wuerden fortgesetzt (verpasste Perioden uebersprungen)" });
        break;
    }
  }
  return { matches, reasons, trigger, source: trigger === null ? null : source, steps };
}
