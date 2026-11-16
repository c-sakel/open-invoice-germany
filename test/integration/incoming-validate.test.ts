/**
 * Pruefung eingehender E-Rechnungen: Ergebnisstatus, Ergebniszeilen (append-only), Grenzen, Rundlauf mit dem
 * echten Validator (nur wenn Validator und Java ab 17 vorhanden sind). Testjahr 2235, ARCHIVE_DIR im Tempverzeichnis.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { archiveRoot } from "@/lib/archive/storage";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { runExclusive } from "@/domain/incoming/exclusive";
import { IncomingBusyError } from "@/domain/incoming/errors";
import { receiveIncomingInvoice } from "@/domain/incoming/receive";
import { queueIncomingValidation, requestIncomingValidation, validateIncomingInvoice } from "@/domain/incoming/validate";
import { selectEngine, type EngineOutcome, type ValidationEngine } from "@/domain/incoming/engine";
import { pdfWithAttachments } from "../helpers/pdf-craft";
import { realValidatorEngine } from "../helpers/real-validator";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const NOW = new Date("2235-03-01T10:00:00.000Z");

let tmp = "";
let prevDir: string | undefined;
let org = "";
let other = "";

async function mkOrg(name: string): Promise<string> {
  const o = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  return o.id;
}

const recv = (orgId: string, bytes: Uint8Array, name = "rechnung.xml") =>
  receiveIncomingInvoice(orgId, bytes, { fileName: name, channel: "UPLOAD", actor: "tester", now: NOW });

/** Prueft nur, was der Test vorgibt (kein Prozess). */
function fakeEngine(outcome: EngineOutcome, calls: { n: number } = { n: 0 }): ValidationEngine {
  return {
    id: "test-engine",
    artefactVersion: "t-1",
    run: () => {
      calls.n++;
      return Promise.resolve(outcome);
    },
  };
}

const finding = (level: "FORMAT" | "ERROR" | "WARNING", ruleId: string) => ({ ruleId, level, location: "/Invoice[1]", text: "Text" });

async function variant(base: string, tag: string): Promise<Buffer> {
  // Gleicher Inhalt waere eine Dublette: ein XML-Kommentar macht die Datei eindeutig.
  return Buffer.from(fx(base).toString("utf8").replace("?>", `?><!-- ${tag} -->`), "utf8");
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "incoming-validate-"));
  prevDir = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmp;
  org = await mkOrg("Eingang Pruefung A GmbH");
  other = await mkOrg("Eingang Pruefung B GmbH");
});

afterAll(async () => {
  if (prevDir === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevDir;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("Ergebnis und Ablage", () => {
  it("Formatfehler oder Regelfehler -> INVALID, nur Warnungen -> WARNINGS, sonst VALID; Zeile und Status in einem Schritt", async () => {
    const cases: [EngineOutcome, string, string][] = [
      [{ findings: [finding("FORMAT", "cvc-x")], formatErrors: 1, ruleErrors: 0, warnings: 0 }, "INVALID", "a"],
      [{ findings: [finding("ERROR", "BR-16")], formatErrors: 0, ruleErrors: 1, warnings: 0 }, "INVALID", "b"],
      [{ findings: [finding("WARNING", "BR-CL-21")], formatErrors: 0, ruleErrors: 0, warnings: 1 }, "WARNINGS", "c"],
      [{ findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 }, "VALID", "d"],
    ];
    for (const [outcome, expected, tag] of cases) {
      const res = await recv(org, await variant("gen-base-ubl.xml", tag));
      expect(res.validationStatus).toBe("PENDING");
      const v = await validateIncomingInvoice(org, res.id, { engine: fakeEngine(outcome), now: NOW });
      expect(v.result).toBe(expected);
      const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { validationStatus: true } });
      expect(row.validationStatus).toBe(expected);
      const z = await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: v.validationId ?? "" } });
      expect(z).toMatchObject({ engine: "test-engine", artefactVersion: "t-1", result: expected, reason: null, formatErrors: outcome && "findings" in outcome ? outcome.formatErrors : -1 });
      expect(JSON.parse(z.findingsJson)).toEqual("findings" in outcome ? outcome.findings : []);
    }
  });

  it("erneute Pruefung legt eine zweite Zeile an, die erste bleibt unveraendert", async () => {
    const res = await recv(org, await variant("gen-base-cii.xml", "zweimal"));
    const first = await validateIncomingInvoice(org, res.id, { engine: fakeEngine({ findings: [finding("ERROR", "BR-16")], formatErrors: 0, ruleErrors: 1, warnings: 0 }), now: NOW });
    const before = await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: first.validationId ?? "" } });
    const second = await validateIncomingInvoice(org, res.id, { engine: fakeEngine({ findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 }), now: new Date(NOW.getTime() + 1000) });
    expect(second.result).toBe("VALID");
    expect(second.validationId).not.toBe(first.validationId);
    expect(await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: res.id } })).toBe(2);
    expect(await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: first.validationId ?? "" } })).toEqual(before);
    expect((await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { validationStatus: true } })).validationStatus).toBe("VALID");
  });

  it("Engine meldet notChecked -> NOT_CHECKED mit Grund", async () => {
    const res = await recv(org, await variant("gen-base-ubl.xml", "nc"));
    const v = await validateIncomingInvoice(org, res.id, { engine: fakeEngine({ notChecked: "TIMEOUT" }), now: NOW });
    expect(v.result).toBe("NOT_CHECKED");
    expect(await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: v.validationId ?? "" } })).toMatchObject({ result: "NOT_CHECKED", reason: "TIMEOUT" });
  });

  it("INCOMING_VALIDATION=off -> NOT_CHECKED/ENGINE_OFF", async () => {
    const res = await recv(org, await variant("gen-base-ubl.xml", "off"));
    const v = await validateIncomingInvoice(org, res.id, { engine: selectEngine({ INCOMING_VALIDATION: "off" }), now: NOW });
    expect(await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: v.validationId ?? "" } })).toMatchObject({ result: "NOT_CHECKED", reason: "ENGINE_OFF" });
  });

  it("MINIMUM und sonstige Rechnungen werden nie geprueft und bekommen keine Zeile", async () => {
    const calls = { n: 0 };
    const minimum = await recv(org, fx("cii-minimum.xml"));
    expect(minimum.validationStatus).toBe("NOT_APPLICABLE");
    const pdf = await recv(org, await pdfWithAttachments([]), "scan.pdf");
    for (const id of [minimum.id, pdf.id]) {
      const v = await validateIncomingInvoice(org, id, { engine: fakeEngine({ findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 }, calls) });
      expect(v).toEqual({ result: "NOT_APPLICABLE", validationId: null });
      expect(await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: id } })).toBe(0);
    }
    expect(calls.n).toBe(0);
  });

  it("mehr als 5.000 Positionen: keine Pruefung, NOT_CHECKED/TOO_MANY_LINES", async () => {
    const xml = fx("gen-base-cii.xml").toString("utf8");
    const item = /<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?<\/ram:IncludedSupplyChainTradeLineItem>/.exec(xml)?.[0] ?? "";
    expect(item).not.toBe("");
    const big = xml.replace(item, item.repeat(5_001));
    const res = await recv(org, Buffer.from(big, "utf8"), "gross.xml");
    expect(res.validationStatus).toBe("NOT_CHECKED");
    const calls = { n: 0 };
    const v = await validateIncomingInvoice(org, res.id, { engine: fakeEngine({ findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 }, calls) });
    expect(await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: v.validationId ?? "" } })).toMatchObject({ result: "NOT_CHECKED", reason: "TOO_MANY_LINES" });
    expect(calls.n).toBe(0);
  });

  it("fremde Organisation und unbekannte Id -> identisches NotFoundError", async () => {
    const res = await recv(org, await variant("gen-base-ubl.xml", "fremd"));
    const a = await validateIncomingInvoice(other, res.id).catch((e: unknown) => e);
    const b = await validateIncomingInvoice(org, "gibt-es-nicht").catch((e: unknown) => e);
    expect(a).toBeInstanceOf(NotFoundError);
    expect(b).toBeInstanceOf(NotFoundError);
    expect((a as Error).message).toBe((b as Error).message);
  });

  it("manipulierte Archivdatei: keine Pruefung, ArchiveTamperedError", async () => {
    const res = await recv(org, await variant("gen-base-ubl.xml", "tamper"));
    const row = await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { originalPath: true } });
    const abs = path.join(archiveRoot(), ...row.originalPath.split("/"));
    fs.appendFileSync(abs, " ");
    const calls = { n: 0 };
    await expect(validateIncomingInvoice(org, res.id, { engine: fakeEngine({ findings: [], formatErrors: 0, ruleErrors: 0, warnings: 0 }, calls) })).rejects.toBeInstanceOf(ArchiveTamperedError);
    expect(calls.n).toBe(0);
    expect(await dbInternal.incomingInvoiceValidation.count({ where: { incomingInvoiceId: res.id } })).toBe(0);
  });

  it("nach der Annahme eingereiht: Pruefung laeuft im Hintergrund, die Annahme wartet nicht", async () => {
    const prevAfter = process.env.INCOMING_VALIDATION_AFTER_RECEIVE;
    const prevMode = process.env.INCOMING_VALIDATION;
    process.env.INCOMING_VALIDATION_AFTER_RECEIVE = "1";
    process.env.INCOMING_VALIDATION = "off";
    try {
      resetRateLimits();
      const res = await recv(org, await variant("gen-base-ubl.xml", "queue"));
      expect(res.validationStatus).toBe("PENDING");
      let status = "PENDING";
      for (let i = 0; i < 100 && status === "PENDING"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = (await dbInternal.incomingInvoice.findUniqueOrThrow({ where: { id: res.id }, select: { validationStatus: true } })).validationStatus;
      }
      expect(status).toBe("NOT_CHECKED");
    } finally {
      if (prevAfter === undefined) delete process.env.INCOMING_VALIDATION_AFTER_RECEIVE;
      else process.env.INCOMING_VALIDATION_AFTER_RECEIVE = prevAfter;
      if (prevMode === undefined) delete process.env.INCOMING_VALIDATION;
      else process.env.INCOMING_VALIDATION = prevMode;
    }
  });

  it("queueIncomingValidation wirft nie, auch bei unbekannter Id", () => {
    const prev = process.env.INCOMING_VALIDATION_AFTER_RECEIVE;
    process.env.INCOMING_VALIDATION_AFTER_RECEIVE = "1";
    try {
      expect(() => queueIncomingValidation("gibt-es-nicht")).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.INCOMING_VALIDATION_AFTER_RECEIVE;
      else process.env.INCOMING_VALIDATION_AFTER_RECEIVE = prev;
    }
  });
});

const real = realValidatorEngine();

describe.skipIf(real === null)("Rundlauf mit dem echten Validator", () => {
  const engine = (): ValidationEngine => {
    if (!real) throw new Error("kein Validator");
    return real;
  };
  const check = async (bytes: Uint8Array, name = "rechnung.xml") => {
    const res = await recv(org, bytes, name);
    const v = await validateIncomingInvoice(org, res.id, { engine: engine(), now: NOW });
    const row = await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: v.validationId ?? "" } });
    return { v, row, findings: JSON.parse(row.findingsJson) as { ruleId: string; level: string }[] };
  };

  it.each(["gen-base-ubl.xml", "gen-base-cii.xml", "gen-credit-note-doc-discount-ubl.xml", "gen-doc-discount-two-rates-cii.xml"])("eigene Rechnung %s ist VALID", async (name) => {
    const { v, row } = await check(await variant(name, `real-${name}`));
    expect(row.engine).toBe("kosit-validator");
    expect(row.artefactVersion).toMatch(/^validator-1\.6\.3\+/);
    expect(v.result).toBe("VALID");
  });

  it("ZUGFeRD-PDF: die eingebettete XML wird geprueft -> VALID", async () => {
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: fx("gen-base-cii.xml") }]);
    const { v } = await check(pdf, "rechnung.pdf");
    expect(v.result).toBe("VALID");
  });

  it("falsche Summen -> INVALID mit BR-CO-15", async () => {
    const { v, findings } = await check(fx("cii-summen-falsch.xml"));
    expect(v.result).toBe("INVALID");
    expect(findings.map((f) => f.ruleId)).toContain("BR-CO-15");
  });

  it("XRechnung ohne Zahlungsangaben -> BR-DE-1", async () => {
    const { v, findings } = await check(fx("ubl-xrechnung-ohne-zahlung.xml"));
    expect(v.result).toBe("INVALID");
    expect(findings.find((f) => f.ruleId === "BR-DE-1")?.level).toBe("ERROR");
  });

  it("Schemaverstoss -> INVALID als Formatfehler", async () => {
    const { v, row, findings } = await check(fx("ubl-schemafehler.xml"));
    expect(v.result).toBe("INVALID");
    expect(row.formatErrors).toBeGreaterThan(0);
    expect(findings[0].level).toBe("FORMAT");
  });

  it("Profil ohne Szenario (EXTENDED) -> NOT_CHECKED/PROFILE_NOT_COVERED", async () => {
    const { v, row } = await check(fx("cii-extended.xml"));
    expect(v.result).toBe("NOT_CHECKED");
    expect(row.reason).toBe("PROFILE_NOT_COVERED");
  });

  it("Zeitgrenze von 1 ms -> NOT_CHECKED/TIMEOUT, die Anwendung laeuft weiter", async () => {
    const res = await recv(org, await variant("gen-base-cii.xml", "timeout"));
    const v = await validateIncomingInvoice(org, res.id, { engine: engine(), timeoutMs: 1, now: NOW });
    expect(v.result).toBe("NOT_CHECKED");
    expect((await dbInternal.incomingInvoiceValidation.findUniqueOrThrow({ where: { id: v.validationId ?? "" } })).reason).toBe("TIMEOUT");
    const again = await validateIncomingInvoice(org, res.id, { engine: engine(), now: NOW });
    expect(again.result).toBe("VALID");
  });

  it("4.900 Positionen werden innerhalb der Zeitgrenze geprueft", async () => {
    const xml = fx("gen-base-cii.xml").toString("utf8");
    const item = /<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?<\/ram:IncludedSupplyChainTradeLineItem>/.exec(xml)?.[0] ?? "";
    const big = xml.replace(item, item.repeat(4_900));
    const { row } = await check(Buffer.from(big, "utf8"), "gross.xml");
    expect(row.reason).toBeNull();
    expect(row.durationMs).toBeLessThan(60_000);
  });
});

describe("manuelle Pruefung wartet nicht hinter einer langen Schlange", () => {
  it("mehr als zwei wartende Pruefungen: sofort IncomingBusyError, danach wieder frei", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = [runExclusive(() => gate), runExclusive(() => gate), runExclusive(() => gate)];
    // drei in der Kette: die vierte (manuelle) Anfrage wird abgewiesen
    expect(() => requestIncomingValidation(org, "gibt-es-nicht")).toThrow(IncomingBusyError);
    release();
    await Promise.all(held);
    await expect(requestIncomingValidation(org, "gibt-es-nicht")).rejects.toBeInstanceOf(NotFoundError);
  });
});
