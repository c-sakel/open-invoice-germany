/** Phase 16d T6 — Kanalwahl der Mahnung (rein). */
import { describe, expect, it } from "vitest";
import { asChannel, asStageChannel, resolveChannels, type Channel, type StageChannel } from "@/domain/postal/channel";
import { customerFieldsSchema, dunningStageFieldsSchema } from "@/schemas";

const stageChannels: StageChannel[] = ["CUSTOMER", "EMAIL", "POST", "EMAIL_AND_POST"];
const customerChannels: Channel[] = ["EMAIL", "POST", "EMAIL_AND_POST"];

/** Erwartung unabhaengig von der Implementierung als Tabelle formuliert. */
function expected(stage: StageChannel, customer: Channel, hasEmail: boolean, fb: boolean) {
  const eff = stage === "CUSTOMER" ? customer : stage;
  if (eff === "POST") return { email: false, post: true, reason: "OK" };
  if (eff === "EMAIL_AND_POST") return { email: hasEmail, post: true, reason: "OK" };
  if (hasEmail) return { email: true, post: false, reason: "OK" };
  return fb ? { email: false, post: true, reason: "FALLBACK_POST" } : { email: false, post: false, reason: "NO_RECIPIENT" };
}

describe("resolveChannels", () => {
  for (const s of stageChannels)
    for (const c of customerChannels)
      for (const hasEmail of [true, false])
        for (const fb of [true, false]) {
          it(`Stufe ${s} / Kunde ${c} / E-Mail ${hasEmail} / Fallback ${fb}`, () => {
            expect(resolveChannels({ stageChannel: s, customerChannel: c, hasEmail, postFallback: fb })).toEqual(expected(s, c, hasEmail, fb));
          });
        }

  it("Kernfaelle", () => {
    expect(resolveChannels({ stageChannel: "CUSTOMER", customerChannel: "EMAIL", hasEmail: false, postFallback: true })).toEqual({ email: false, post: true, reason: "FALLBACK_POST" });
    expect(resolveChannels({ stageChannel: "CUSTOMER", customerChannel: "EMAIL", hasEmail: false, postFallback: false }).reason).toBe("NO_RECIPIENT");
    expect(resolveChannels({ stageChannel: "POST", customerChannel: "EMAIL", hasEmail: true, postFallback: false })).toEqual({ email: false, post: true, reason: "OK" });
    expect(resolveChannels({ stageChannel: "EMAIL_AND_POST", customerChannel: "EMAIL", hasEmail: false, postFallback: false })).toEqual({ email: false, post: true, reason: "OK" });
  });

  it("unbekannte Datenbankwerte gelten als E-Mail bzw. Kundenkanal", () => {
    expect(asChannel("x")).toBe("EMAIL");
    expect(asChannel(undefined)).toBe("EMAIL");
    expect(asStageChannel("x")).toBe("CUSTOMER");
    expect(asStageChannel("POST")).toBe("POST");
  });
});

describe("Schemas", () => {
  const stage = { name: "S", daysAfterDue: 1, newDueDays: 7, feeCents: 0, calculateInterest: true, includeB2BFlatFee: false };
  it("Stufe akzeptiert channel/postFallback, Standard bleibt unbesetzt", () => {
    expect(dunningStageFieldsSchema.parse(stage).channel).toBeUndefined();
    expect(dunningStageFieldsSchema.parse({ ...stage, channel: "POST", postFallback: false })).toMatchObject({ channel: "POST", postFallback: false });
    expect(() => dunningStageFieldsSchema.parse({ ...stage, channel: "FAX" })).toThrow();
  });
  const cust = { name: "K", addressLine1: "A", postalCode: "1", city: "C" };
  it("Kunde: deliveryChannel validiert", () => {
    expect(customerFieldsSchema.parse({ ...cust, deliveryChannel: "EMAIL_AND_POST" }).deliveryChannel).toBe("EMAIL_AND_POST");
    expect(() => customerFieldsSchema.parse({ ...cust, deliveryChannel: "BRIEFTAUBE" })).toThrow();
  });
});
