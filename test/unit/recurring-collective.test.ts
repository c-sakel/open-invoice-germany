import { describe, expect, it } from "vitest";
import {
  assembleCollectiveLines,
  collectiveBlockRanges,
  collectiveHeaderText,
  collectivePeriod,
  selectCollectiveGroup,
  splitReasons,
  stichtagKey,
  type CollectiveBlock,
  type CollectiveCandidate,
} from "@/domain/recurring/collective";
import type { CreateInvoiceInput } from "@/schemas";

type Line = CreateInvoiceInput["lines"][number];

function cand(id: string, over: Partial<CollectiveCandidate> = {}): CollectiveCandidate {
  return {
    id, orgId: "o1", customerId: "c1", status: "ACTIVE", collectiveBilling: true,
    nextRunDate: new Date("2205-03-01T00:00:00Z"), createdAt: new Date("2205-01-01T00:00:00Z"),
    currency: "EUR", taxScheme: "REGULAR", language: "de", paymentTermsDays: 14,
    autoFinalize: false, autoSend: false, emailTemplateId: null, ...over,
  };
}

function item(desc: string, start?: string, end?: string, lineType: Line["lineType"] = "ITEM"): Line {
  return {
    lineType, description: desc, quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100, taxRate: 19,
    taxCategory: "S", discountPermille: 0, discountCents: 0,
    servicePeriodStart: start ? new Date(start) : undefined,
    servicePeriodEnd: end ? new Date(end) : undefined,
  };
}

function block(id: string, lines: Line[], over: Partial<CollectiveBlock> = {}): CollectiveBlock {
  return {
    recurringId: id, heading: `Block ${id}`, showPeriodText: true,
    periodStart: new Date("2205-02-01T00:00:00Z"), periodEnd: new Date("2205-03-01T00:00:00Z"), lines, ...over,
  };
}

describe("stichtagKey", () => {
  it("nutzt den Berliner Kalendertag", () => {
    expect(stichtagKey(new Date("2205-01-10T12:00:00Z"))).toBe("2205-01-10");
    expect(stichtagKey(new Date("2205-01-10T23:30:00Z"))).toBe("2205-01-11");
    expect(stichtagKey(new Date("2205-07-10T12:00:00Z"))).toBe("2205-07-10");
    expect(stichtagKey(new Date("2205-07-10T22:30:00Z"))).toBe("2205-07-11");
    expect(stichtagKey(new Date("2205-01-31T23:30:00Z"))).toBe("2205-02-01");
  });
});

describe("splitReasons", () => {
  it("gleiche Abos -> leer", () => {
    expect(splitReasons(cand("a"), cand("b"))).toEqual([]);
  });
  it.each([
    ["currency", { currency: "USD" }],
    ["taxScheme", { taxScheme: "REVERSE_CHARGE" }],
    ["language", { language: "en" }],
    ["paymentTermsDays", { paymentTermsDays: 30 }],
    ["autoFinalize", { autoFinalize: true }],
    ["autoSend", { autoSend: true }],
    ["emailTemplateId", { autoSend: true, emailTemplateId: "t1" }],
  ] as const)("Grund %s", (field, over) => {
    expect(splitReasons(cand("a", { autoSend: field === "emailTemplateId" }), cand("b", over))).toEqual([field]);
  });
});

describe("selectCollectiveGroup", () => {
  it("zwei gleiche -> beide Mitglieder", () => {
    const a = cand("a");
    const r = selectCollectiveGroup(a, [a, cand("b")]);
    expect(r.members).toEqual(["a", "b"]);
    expect(r.split).toEqual([]);
  });
  it("PAUSED, ohne Schalter, anderer Kunde, anderer Tag -> weder Mitglied noch split", () => {
    const a = cand("a");
    const r = selectCollectiveGroup(a, [
      cand("p", { status: "PAUSED" }),
      cand("n", { collectiveBilling: false }),
      cand("k", { customerId: "c2" }),
      cand("d", { nextRunDate: new Date("2205-03-02T00:00:00Z") }),
    ]);
    expect(r).toEqual({ members: ["a"], split: [], overflow: [] });
  });
  it("abweichende Waehrung -> split", () => {
    const a = cand("a");
    const r = selectCollectiveGroup(a, [cand("b", { currency: "USD" })]);
    expect(r.members).toEqual(["a"]);
    expect(r.split).toEqual([{ id: "b", reasons: ["currency"] }]);
  });
  it("maxMembers: Ausloeser plus aeltester", () => {
    const a = cand("a", { createdAt: new Date("2205-01-03T00:00:00Z") });
    const b = cand("b", { createdAt: new Date("2205-01-02T00:00:00Z") });
    const c = cand("c", { createdAt: new Date("2205-01-01T00:00:00Z") });
    const r = selectCollectiveGroup(a, [a, b, c], 2);
    expect(r.members).toEqual(["c", "a"]);
  });
  it("Reihenfolge stabil nach createdAt, dann id", () => {
    const t = new Date("2205-01-01T00:00:00Z");
    const r = selectCollectiveGroup(cand("z", { createdAt: t }), [cand("b", { createdAt: t }), cand("a", { createdAt: t })]);
    expect(r.members).toEqual(["a", "b", "z"]);
  });
});

describe("assembleCollectiveLines", () => {
  it("zwei einfache Bloecke mit Zwischensumme", () => {
    const { lines, origins } = assembleCollectiveLines(
      [block("A", [item("a1")]), block("B", [item("b1"), item("b2")])],
      "de",
    );
    expect(lines.map((l) => l.lineType)).toEqual(["HEADING", "ITEM", "SUBTOTAL", "HEADING", "ITEM", "ITEM", "SUBTOTAL"]);
    expect(origins).toEqual(["A", "A", "A", "B", "B", "B", "B"]);
    expect(lines[0].description).toBe("Block A");
    expect(lines[2].description).toBe("Zwischensumme");
  });
  it("Block mit eigener HEADING -> keine Zwischensumme", () => {
    const { lines } = assembleCollectiveLines([block("A", [item("Eigen", undefined, undefined, "HEADING"), item("a1")])], "de");
    expect(lines.map((l) => l.lineType)).toEqual(["HEADING", "HEADING", "ITEM"]);
  });
  it("englisch -> Subtotal", () => {
    const { lines } = assembleCollectiveLines([block("A", [item("a1")])], "en");
    expect(lines[2].description).toBe("Subtotal");
  });
  it("Gliederungszeilen ohne Betraege", () => {
    const { lines } = assembleCollectiveLines([block("A", [item("a1")])], "de");
    for (const i of [0, 2]) {
      expect([lines[i].quantityMilli, lines[i].unitNetPriceCents, lines[i].taxRate]).toEqual([0, 0, 0]);
    }
  });
});

describe("collectivePeriod", () => {
  it("Min/Max ueber ITEM-Zeitraeume", () => {
    const p = collectivePeriod([
      item("fest", "2205-03-01T00:00:00Z", "2205-03-31T00:00:00Z"),
      item("verbrauch", "2205-02-01T00:00:00Z", "2205-03-31T00:00:00Z"),
    ]);
    expect(p).toEqual({ start: new Date("2205-02-01T00:00:00Z"), end: new Date("2205-03-31T00:00:00Z") });
  });
  it("HEADING-Zeitraeume ignoriert, keine -> null", () => {
    expect(collectivePeriod([item("h", "2205-01-01T00:00:00Z", "2205-12-31T00:00:00Z", "HEADING")])).toBeNull();
    expect(collectivePeriod([item("x")])).toBeNull();
  });
});

describe("collectiveHeaderText", () => {
  it("alle an -> Min/Max", () => {
    const t = collectiveHeaderText([
      block("A", [], { periodStart: new Date("2205-02-01T00:00:00Z"), periodEnd: new Date("2205-03-01T00:00:00Z") }),
      block("B", [], { periodStart: new Date("2205-01-01T00:00:00Z"), periodEnd: new Date("2205-02-01T00:00:00Z") }),
    ]);
    expect(t).toBe("Abrechnungszeitraum 01.01.2205 – 01.03.2205");
  });
  it("einer aus -> undefined", () => {
    expect(collectiveHeaderText([block("A", []), block("B", [], { showPeriodText: false })])).toBeUndefined();
  });
});

describe("collectiveBlockRanges", () => {
  it("zwei Bereiche, null ignoriert", () => {
    expect(
      collectiveBlockRanges([
        { position: 1, recurringInvoiceId: "A" },
        { position: 2, recurringInvoiceId: "A" },
        { position: 3, recurringInvoiceId: "B" },
        { position: 4, recurringInvoiceId: "B" },
        { position: 5, recurringInvoiceId: null },
      ]),
    ).toEqual([
      { recurringId: "A", from: 1, to: 2 },
      { recurringId: "B", from: 3, to: 4 },
    ]);
  });
});

describe("selectCollectiveGroup: Ueberhang, Organisation, Mailvorlage", () => {
  it("gibt den Ueberhang jenseits der Obergrenze zurueck", () => {
    const t = cand("a", { createdAt: new Date("2205-01-01T00:00:00Z") });
    const others = ["b", "c", "d"].map((id, i) => cand(id, { createdAt: new Date(`2205-01-0${i + 2}T00:00:00Z`) }));
    const g = selectCollectiveGroup(t, others, 2);
    expect(g.members).toEqual(["a", "b"]);
    expect(g.overflow).toEqual(["c", "d"]);
  });

  it("Abo einer anderen Organisation -> Fehler", () => {
    expect(() => selectCollectiveGroup(cand("a"), [cand("b", { orgId: "o2" })])).toThrow();
  });

  it("emailTemplateId trennt nur bei autoSend", () => {
    expect(splitReasons(cand("a", { emailTemplateId: "t1" }), cand("b", { emailTemplateId: "t2" }))).toEqual([]);
    expect(splitReasons(cand("a", { autoSend: true, emailTemplateId: "t1" }), cand("b", { autoSend: true, emailTemplateId: "t2" }))).toEqual(["emailTemplateId"]);
  });
});
