import { describe, it, expect } from "vitest";
import { availableActions, convertTargets, type ActionableDoc } from "@/domain/document/actions";

function doc(overrides: Partial<ActionableDoc>): ActionableDoc {
  return { kind: "INVOICE", type: "INVOICE", status: "OPEN", isDraft: false, ...overrides };
}

describe("availableActions", () => {
  it("Rechnungs-Entwurf: OPEN, PDF, EDIT, DUPLICATE, SEND — kein XRECHNUNG/PAYMENT/CANCEL", () => {
    const actions = availableActions(doc({ status: "DRAFT", isDraft: true }));
    expect(actions).toEqual(expect.arrayContaining(["OPEN", "PDF", "EDIT", "DUPLICATE", "SEND"]));
    expect(actions).not.toContain("XRECHNUNG");
    expect(actions).not.toContain("PAYMENT");
    expect(actions).not.toContain("CANCEL");
  });

  it("Festgeschrieben/OPEN, noch nie versendet: XRECHNUNG, SEND, PAYMENT, CANCEL — kein RESEND/REMINDER/DUNNING", () => {
    const actions = availableActions(doc({ status: "OPEN", isDraft: false, hasEmailLog: false }));
    expect(actions).toEqual(expect.arrayContaining(["XRECHNUNG", "SEND", "PAYMENT", "CANCEL"]));
    expect(actions).not.toContain("RESEND");
    expect(actions).not.toContain("REMINDER");
    expect(actions).not.toContain("DUNNING");
  });

  it("Bereits versendet: RESEND statt SEND", () => {
    const actions = availableActions(doc({ status: "OPEN", isDraft: false, hasEmailLog: true }));
    expect(actions).toContain("RESEND");
    expect(actions).not.toContain("SEND");
  });

  it("Ueberfaellig mit aktivem Mahnprozess: REMINDER + DUNNING", () => {
    const actions = availableActions(doc({ status: "OVERDUE", dunningState: "ACTIVE" }));
    expect(actions).toEqual(expect.arrayContaining(["REMINDER", "DUNNING", "PAYMENT", "CANCEL"]));
  });

  it("Ueberfaellig, aber Mahnprozess pausiert: kein REMINDER/DUNNING", () => {
    const actions = availableActions(doc({ status: "OVERDUE", dunningState: "PAUSED" }));
    expect(actions).not.toContain("REMINDER");
    expect(actions).not.toContain("DUNNING");
  });

  it("PAID: kein PAYMENT mehr, CANCEL bleibt moeglich (Stornogutschrift)", () => {
    const actions = availableActions(doc({ status: "PAID" }));
    expect(actions).not.toContain("PAYMENT");
    expect(actions).toContain("CANCEL");
  });

  it("CANCELLED: keine SEND/PAYMENT/CANCEL/REMINDER/DUNNING mehr", () => {
    const actions = availableActions(doc({ status: "CANCELLED" }));
    expect(actions).not.toContain("SEND");
    expect(actions).not.toContain("RESEND");
    expect(actions).not.toContain("PAYMENT");
    expect(actions).not.toContain("CANCEL");
    expect(actions).not.toContain("REMINDER");
    expect(actions).not.toContain("DUNNING");
    expect(actions).toEqual(expect.arrayContaining(["OPEN", "PDF"]));
  });

  it("CREDIT_NOTE: nicht zahlbar, nicht stornierbar, nicht mahnbar", () => {
    const actions = availableActions(doc({ status: "OPEN", type: "CREDIT_NOTE" }));
    expect(actions).not.toContain("PAYMENT");
    expect(actions).not.toContain("CANCEL");
    expect(actions).not.toContain("REMINDER");
  });

  it("PARTIAL/DOWNPAYMENT/FINAL: kein DUPLICATE (haengen an einer Quelle)", () => {
    for (const type of ["PARTIAL", "DOWNPAYMENT", "FINAL"]) {
      const actions = availableActions(doc({ status: "OPEN", type }));
      expect(actions).not.toContain("DUPLICATE");
      // aber weiterhin stornierbar/zahlbar wie eine normale Rechnung
      expect(actions).toEqual(expect.arrayContaining(["PAYMENT", "CANCEL"]));
    }
  });

  it("Angebot DRAFT: EDIT, DUPLICATE, SEND, kein DELIVERY_NOTE/CANCEL", () => {
    const actions = availableActions({ kind: "QUOTE", type: "ANGEBOT", status: "DRAFT", isDraft: true });
    expect(actions).toEqual(expect.arrayContaining(["EDIT", "DUPLICATE", "SEND"]));
    expect(actions).not.toContain("DELIVERY_NOTE");
    expect(actions).not.toContain("CANCEL");
  });

  it("Angebot ACCEPTED: DELIVERY_NOTE verfuegbar", () => {
    const actions = availableActions({ kind: "QUOTE", type: "ANGEBOT", status: "ACCEPTED", isDraft: false });
    expect(actions).toContain("DELIVERY_NOTE");
    expect(actions).toContain("CANCEL");
  });

  it("Angebot REJECTED: kein SEND/DELIVERY_NOTE mehr", () => {
    const actions = availableActions({ kind: "QUOTE", type: "ANGEBOT", status: "REJECTED", isDraft: false });
    expect(actions).not.toContain("SEND");
    expect(actions).not.toContain("RESEND");
    expect(actions).not.toContain("DELIVERY_NOTE");
  });

  it("Lieferschein CREATED: SEND, CANCEL, kein PAYMENT/DUNNING", () => {
    const actions = availableActions({ kind: "DELIVERY_NOTE", type: "", status: "CREATED", isDraft: false });
    expect(actions).toEqual(expect.arrayContaining(["SEND", "CANCEL"]));
    expect(actions).not.toContain("PAYMENT");
    expect(actions).not.toContain("DUNNING");
  });

  it("Abo (RECURRING): nur OPEN/EDIT, keine Beleg-Aktionen", () => {
    const actions = availableActions({ kind: "RECURRING", type: "", status: "ACTIVE", isDraft: false });
    expect(actions).toEqual(["OPEN", "EDIT"]);
  });
});

describe("convertTargets", () => {
  const quote = (status: string, extra = {}) => ({ kind: "QUOTE" as const, type: "ANGEBOT", status, isDraft: status === "DRAFT", ...extra });

  it("Angebot: AB, Rechnung und Lieferschein in DRAFT/SENT/ACCEPTED/EXPIRED", () => {
    for (const s of ["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]) {
      expect(convertTargets(quote(s))).toEqual({ orderConfirmation: true, invoice: true, deliveryNote: true });
      expect(availableActions(quote(s))).toContain("CONVERT");
    }
  });

  it("umgewandelt / vollstaendig berechnet / AB / PROFORMA / storniert", () => {
    expect(convertTargets(quote("SENT", { convertedToInvoiceId: "inv1" })).orderConfirmation).toBe(false);
    // Fix-Welle M5: billingFull sperrt NUR die Rechnung, nicht mehr den Lieferschein —
    // convertTargets folgt jetzt exakt der serverseitigen Regel in convert.ts (nur
    // Status, kein Abrechnungsstand fuer die Lieferschein-Konvertierung).
    expect(convertTargets(quote("ACCEPTED", { billingFull: true }))).toEqual({ orderConfirmation: true, invoice: false, deliveryNote: true });
    expect(convertTargets({ ...quote("ACCEPTED"), type: "AUFTRAGSBESTAETIGUNG" }).invoice).toBe(false);
    expect(availableActions(quote("CANCELLED"))).not.toContain("CONVERT");
  });

  it("Fix-Welle M5: PROFORMA darf in einen Lieferschein umgewandelt werden (Server prueft in convert.ts nur den Status, nicht kind)", () => {
    for (const s of ["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]) {
      expect(convertTargets({ ...quote(s), type: "PROFORMA" }).deliveryNote).toBe(true);
    }
    // orderConfirmation/invoice bleiben fuer PROFORMA weiterhin gesperrt (kein Angebot/AB).
    expect(convertTargets({ ...quote("SENT"), type: "PROFORMA" })).toMatchObject({ orderConfirmation: false, invoice: false });
  });

  it("Fix-Welle M5: voll abgerechnetes Angebot/AB darf weiterhin einen Lieferschein erzeugen (Rechnung bleibt gesperrt)", () => {
    expect(convertTargets(quote("SENT", { billingFull: true }))).toMatchObject({ invoice: false, deliveryNote: true });
    expect(convertTargets({ ...quote("SENT", { billingFull: true }), type: "AUFTRAGSBESTAETIGUNG" })).toMatchObject({ invoice: false, deliveryNote: true });
  });
});
