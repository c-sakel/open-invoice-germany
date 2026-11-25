/**
 * Mahnuebersicht seitenweise: Widgets/Summen ueber ALLE Treffer, Zeilen nur die Seite. Testjahr 2270.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DUNNING_ALL_ROWS, loadDunningOverview } from "@/domain/dunning/overview";
import { createDunning } from "@/domain/dunning/create";
import { mkBankOrg, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2270-01-10T10:00:00.000Z");
const NOW = new Date("2270-06-01T10:00:00.000Z");
const COUNT = 75;

let org: BankTestOrg;
const ids: string[] = [];
let grossSum = 0;

beforeAll(async () => {
  org = await mkBankOrg("Mahnliste Seiten GmbH", ISSUE);
  for (let i = 0; i < COUNT; i++) {
    const inv = await mkInvoice(org, ISSUE, { netCents: 10000 + i * 7 });
    ids.push(inv.id);
    grossSum += inv.grossCents;
  }
  for (const id of ids.slice(0, 3)) await createDunning(id, { now: NOW, force: true, orgId: org.orgId });
}, 600_000);

describe("loadDunningOverview seitenweise", () => {
  it("Standard: 50 Zeilen, total 75, Summe ueber alle Rechnungen", async () => {
    const o = await loadDunningOverview(org.orgId, NOW);
    expect(o.rows).toHaveLength(50);
    expect(o.total).toBe(COUNT);
    expect(o.offset).toBe(0);
    expect(o.limit).toBe(50);
    expect(o.widgets.overdueCount).toBe(COUNT);
    expect(o.widgets.openTotalCents).toBe(grossSum);
  });

  it("offset 50 liefert die restlichen 25, Widgets unveraendert", async () => {
    const o = await loadDunningOverview(org.orgId, NOW, { offset: 50 });
    expect(o.rows).toHaveLength(25);
    expect(o.widgets.openTotalCents).toBe(grossSum);
    const first = await loadDunningOverview(org.orgId, NOW);
    const overlap = o.rows.filter((r) => first.rows.some((f) => f.invoiceId === r.invoiceId));
    expect(overlap).toHaveLength(0);
  });

  it("Filter stageOrder reduziert total", async () => {
    const all = await loadDunningOverview(org.orgId, NOW, { limit: DUNNING_ALL_ROWS });
    const staged = all.rows.find((r) => r.currentStage);
    expect(staged).toBeDefined();
    const o = await loadDunningOverview(org.orgId, NOW, { stageOrder: staged!.currentStage!.order });
    expect(o.total).toBe(3);
    expect(o.rows).toHaveLength(3);
  });

  it("ohne Seitenschnitt (REST/MCP) alle Zeilen", async () => {
    const o = await loadDunningOverview(org.orgId, NOW, { limit: DUNNING_ALL_ROWS });
    expect(o.rows).toHaveLength(COUNT);
  });
});
