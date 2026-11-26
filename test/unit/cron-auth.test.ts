/** O-06/S-04: Cron-Secret nur als Bearer-Header, zeitkonstant verglichen. */
import { afterEach, describe, expect, it } from "vitest";
import { checkCronAuth } from "@/lib/cron-auth";

const ORIGINAL = process.env.CRON_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

const req = (headers: Record<string, string> = {}, query = "") => new Request(`http://localhost/api/cron/run-all${query}`, { headers });

describe("checkCronAuth", () => {
  it("richtiger Header -> ok", () => {
    process.env.CRON_SECRET = "geheim";
    expect(checkCronAuth(req({ authorization: "Bearer geheim" }))).toBe("ok");
  });
  it("falscher Header -> unauthorized", () => {
    process.env.CRON_SECRET = "geheim";
    expect(checkCronAuth(req({ authorization: "Bearer falsch" }))).toBe("unauthorized");
  });
  it("?secret= ohne Header -> unauthorized", () => {
    process.env.CRON_SECRET = "geheim";
    expect(checkCronAuth(req({}, "?secret=geheim"))).toBe("unauthorized");
  });
  it("ohne Env -> unset", () => {
    delete process.env.CRON_SECRET;
    expect(checkCronAuth(req({ authorization: "Bearer x" }))).toBe("unset");
  });
  it("Header mit anderer Laenge -> unauthorized, kein Throw", () => {
    process.env.CRON_SECRET = "geheim";
    expect(checkCronAuth(req({ authorization: "Bearer " + "x".repeat(500) }))).toBe("unauthorized");
    expect(checkCronAuth(req({ authorization: "B" }))).toBe("unauthorized");
  });
});
