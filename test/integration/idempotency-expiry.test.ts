/**
 * Phase 18d Fix-Welle 2: Ablauf-Zweig von beginIdempotency — zwei gleichzeitige Begins mit abgelaufenem Key,
 * genau einer gewinnt; eine frisch reservierte Zeile wird nie geloescht.
 */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { beginIdempotency, IdempotencyInProgressError } from "@/api/idempotency";

const ORG = "idem-expiry-org";

describe("beginIdempotency — abgelaufener Schluessel", () => {
  it("zwei gleichzeitige Begins: genau einer reserviert, der andere erhaelt IN_PROGRESS", async () => {
    const key = `expired-${Date.now()}`;
    await dbInternal.apiIdempotency.create({
      data: { orgId: ORG, key, requestHash: "alt", status: "DONE", statusCode: 200, responseJson: "{}", createdAt: new Date(Date.now() - 25 * 3600_000) },
    });
    const results = await Promise.allSettled([
      beginIdempotency(ORG, key, "POST", "/x", "{}"),
      beginIdempotency(ORG, key, "POST", "/x", "{}"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled" && r.value === null);
    const lost = results.filter((r) => r.status === "rejected" && r.reason instanceof IdempotencyInProgressError);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const rows = await dbInternal.apiIdempotency.findMany({ where: { orgId: ORG, key }, select: { status: true } });
    expect(rows).toEqual([{ status: "IN_PROGRESS" }]);
  });
});
