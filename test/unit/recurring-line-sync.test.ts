import { describe, it, expect } from "vitest";
import { planLineSync } from "@/domain/recurring/lines";
import { RecurringError } from "@/domain/recurring/errors";

const fixed = (id: string, openUsage = 0) => ({ id, billing: "FIXED", openUsage });
const usage = (id: string, openUsage = 0) => ({ id, billing: "USAGE", openUsage });

describe("planLineSync", () => {
  it("gleiche Ids -> update, ohne Id -> create, fehlende -> delete", () => {
    const plan = planLineSync([fixed("a"), fixed("b"), fixed("c")], [{ id: "a", billing: "FIXED" }, { billing: "FIXED" }, { id: "c" }]);
    expect(plan).toEqual({ update: ["a", "c"], create: [1], delete: ["b"] });
  });
  it("fehlende USAGE-Zeile mit offenem Verbrauch -> Fehler", () => {
    expect(() => planLineSync([fixed("a"), usage("u", 3)], [{ id: "a", billing: "FIXED" }])).toThrow(RecurringError);
    expect(() => planLineSync([fixed("a"), usage("u", 3)], [{ id: "a", billing: "FIXED" }])).toThrow(/offene Verbräuche/);
  });
  it("fehlende USAGE-Zeile ohne offenen Verbrauch darf entfallen", () => {
    expect(planLineSync([usage("u", 0)], [{ billing: "FIXED" }]).delete).toEqual(["u"]);
  });
  it("USAGE -> FIXED mit offenem Verbrauch -> Fehler, ohne Verbrauch erlaubt", () => {
    expect(() => planLineSync([usage("u", 2)], [{ id: "u", billing: "FIXED" }])).toThrow(/offene Verbräuche/);
    expect(planLineSync([usage("u", 0)], [{ id: "u", billing: "FIXED" }]).update).toEqual(["u"]);
  });
  it("USAGE bleibt USAGE mit offenem Verbrauch -> update", () => {
    expect(planLineSync([usage("u", 2)], [{ id: "u", billing: "USAGE" }]).update).toEqual(["u"]);
  });
  it("fremde oder doppelte Id -> Fehler", () => {
    expect(() => planLineSync([fixed("a")], [{ id: "x", billing: "FIXED" }])).toThrow(/Unbekannte/);
    expect(() => planLineSync([fixed("a")], [{ id: "a", billing: "FIXED" }, { id: "a", billing: "FIXED" }])).toThrow(/mehrfach/);
  });
  it("FIXED-Zeile ohne Verbrauch loeschen ist ok", () => {
    expect(planLineSync([fixed("a")], [{ billing: "FIXED" }]).delete).toEqual(["a"]);
  });
});
