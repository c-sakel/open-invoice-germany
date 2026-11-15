import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/einstellungen/zahlungsregeln/actions", () => ({
  createPaymentRuleAction: async () => ({ ok: true, data: { id: "x" } }),
  updatePaymentRuleAction: async () => ({ ok: true }),
  archivePaymentRuleAction: async () => ({ ok: true }),
  previewPaymentRuleAction: async () => ({ ok: false, error: "x" }),
  retryPaymentRuleRunAction: async () => ({ ok: true }),
}));

import { PaymentRuleForm } from "@/components/payment-rules/PaymentRuleForm";
import { PaymentRuleRunsTable, type RunRow } from "@/components/payment-rules/PaymentRuleRunsTable";
import { PaymentRuleRunLines } from "@/components/payment-rules/PaymentRuleRunLines";
import { PreviewResult, isPreviewWarning } from "@/components/payment-rules/PaymentRuleList";
import { emptyRuleFormState, validateRuleForm, isMailFollowUp } from "@/components/payment-rules/rule-form-model";
import { SETTINGS_GROUPS, SETTINGS_ITEMS } from "@/lib/nav";

const templates = [
  { id: "t1", name: "Danke Zahlung", docType: "PAYMENT_CONFIRMATION" },
  { id: "t2", name: "Rechnungsmail", docType: "INVOICE" },
];

function form(initialPatch: Partial<ReturnType<typeof emptyRuleFormState>> = {}): string {
  return renderToStaticMarkup(<PaymentRuleForm tags={[{ id: "g1", name: "Bezahlt" }]} templates={templates} initial={{ ...emptyRuleFormState(), ...initialPatch }} />);
}

describe("Regelformular", () => {
  it("zeigt die Abo-Option nur mit aktivierter Abo-Aktion", () => {
    expect(form()).not.toContain("Verpasste Perioden");
    expect(form({ resume: { on: true, missedPeriods: "SKIP" } })).toContain("Verpasste Perioden nachberechnen");
  });

  it("listet bei der Vorlagenauswahl nur den Typ Zahlungsbestaetigung", () => {
    const html = form({ confirm: { on: true, templateId: "" } });
    expect(html).toContain("Danke Zahlung");
    expect(html).not.toContain("Rechnungsmail");
    expect(html).toContain("/einstellungen/vorlagen");
  });

  it("nennt die Wartezeit-Erklaerung", () => {
    expect(form()).toContain("Gegenbuchung innerhalb der Wartezeit");
  });
});

describe("Validierung mit deutschen Meldungen", () => {
  it("Name und Aktion sind Pflicht", () => {
    const r1 = validateRuleForm(emptyRuleFormState());
    expect(r1).toEqual({ ok: false, error: expect.stringContaining("Namen") });
    const r2 = validateRuleForm({ ...emptyRuleFormState(), name: "A" });
    expect(r2).toEqual({ ok: false, error: expect.stringContaining("mindestens eine Aktion") });
  });
  it("Quellen, Wartezeit und Tag der Aktion", () => {
    const base = { ...emptyRuleFormState(), name: "A", notify: { on: true, note: "" } };
    expect(validateRuleForm({ ...base, allSources: false, sources: [] })).toEqual({ ok: false, error: expect.stringContaining("Quelle") });
    expect(validateRuleForm({ ...base, delayMinutes: "abc" })).toEqual({ ok: false, error: expect.stringContaining("Wartezeit") });
    expect(validateRuleForm({ ...base, tag: { on: true, tagId: "" } })).toEqual({ ok: false, error: expect.stringContaining("Tag") });
    expect(validateRuleForm(base).ok).toBe(true);
  });
});

const run = (over: Partial<RunRow>): RunRow => ({
  id: "r1", createdAt: "2214-03-06T10:00:00.000Z", invoiceId: "i1", invoiceNumber: "RE-1", ruleName: "Danke", status: "DONE",
  steps: [{ type: "NOTIFY", status: "DONE" }], lastError: null, skipReason: null, ...over,
});

describe("Laufliste", () => {
  it("zeigt Status-Labels und den Retry-Knopf nur bei FAILED", () => {
    const html = renderToStaticMarkup(
      <PaymentRuleRunsTable runs={[
        run({ id: "a", status: "DONE" }), run({ id: "b", status: "SKIPPED", skipReason: "Gegenbuchung" }),
        run({ id: "c", status: "FAILED", steps: [{ type: "NOTIFY", status: "FAILED" }], lastError: "Aktion fehlgeschlagen – Details im Server-Protokoll" }),
      ]} />,
    );
    expect(html).toContain("erledigt");
    expect(html).toContain("übersprungen");
    expect(html).toContain("fehlgeschlagen");
    expect(html.match(/Erneut versuchen/g)).toHaveLength(1);
    expect(html).not.toContain("Folgeversand");
  });

  it("kennzeichnet den Retry eines Mail-Schritts als Folgeversand", () => {
    const steps = [{ type: "SEND_PAYMENT_CONFIRMATION", status: "FAILED", error: "Versand unklar – E-Mail-Protokoll pruefen" }];
    expect(isMailFollowUp(steps)).toBe(true);
    expect(isMailFollowUp([{ type: "NOTIFY", status: "FAILED" }])).toBe(false);
    expect(isMailFollowUp([{ type: "SEND_PAYMENT_CONFIRMATION", status: "FAILED", error: "Aktion fehlgeschlagen" }])).toBe(false);
    const html = renderToStaticMarkup(<PaymentRuleRunsTable runs={[run({ status: "FAILED", steps })]} />);
    expect(html).toContain("Folgeversand erneut versuchen");
  });
});

describe("Belegansicht und Trockenlauf", () => {
  it("Zeile Regeln pro Zahlung", () => {
    expect(renderToStaticMarkup(<PaymentRuleRunLines runs={[]} />)).toBe("");
    const html = renderToStaticMarkup(<PaymentRuleRunLines runs={[{ ruleName: "Danke", status: "PENDING" }]} />);
    expect(html).toContain("Regeln: ");
    expect(html).toContain("Danke – geplant");
  });

  it("Trockenlauf-Hinweise sind sichtbar hervorgehoben", () => {
    expect(isPreviewWarning("wuerde fehlschlagen: keine Mail-Einstellungen hinterlegt")).toBe(true);
    expect(isPreviewWarning("wuerde verschoben: Versandgrenze je Kunde erreicht")).toBe(true);
    expect(isPreviewWarning("wuerde nicht erneut senden: Bestaetigung bereits versendet")).toBe(true);
    expect(isPreviewWarning("Mail an a@b.example")).toBe(false);
    const html = renderToStaticMarkup(
      <PreviewResult result={{ matches: true, reasons: [], trigger: "PAID_FULL", source: "MANUAL", steps: [{ type: "SEND_PAYMENT_CONFIRMATION", outcome: "wuerde fehlschlagen: keine Mail-Einstellungen hinterlegt", mail: { to: "a@b.example", subject: "Danke", body: "Text" } }] }} />,
    );
    expect(html).toContain("text-stamp");
    expect(html).toContain("keine Mail-Einstellungen");
  });
});

describe("Navigation", () => {
  it("Nach Zahlungseingang genau einmal in der Gruppe System", () => {
    expect(SETTINGS_ITEMS.filter((i) => i.label === "Nach Zahlungseingang")).toHaveLength(1);
    const inGroups = SETTINGS_GROUPS.filter((g) => g.keys.includes("zahlungsregeln"));
    expect(inGroups.map((g) => g.label)).toEqual(["System"]);
  });
});
