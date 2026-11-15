import { describe, expect, it } from "vitest";
import { ATTEMPT_ERROR_CREATE_FAILED, ATTEMPT_ERROR_GENERIC, ATTEMPT_ERROR_UNCLEAR, publicAttemptError } from "@/domain/online-payment/views";

describe("publicAttemptError", () => {
  it("laesst feste Hinweistexte durch und reduziert Rohfehler auf einen allgemeinen Hinweis", () => {
    expect(publicAttemptError(null)).toBeNull();
    expect(publicAttemptError(ATTEMPT_ERROR_UNCLEAR)).toBe(ATTEMPT_ERROR_UNCLEAR);
    expect(publicAttemptError(ATTEMPT_ERROR_CREATE_FAILED)).toBe(ATTEMPT_ERROR_CREATE_FAILED);
    const raw = "connect ECONNREFUSED 10.0.0.5:443 api.interner-host.example";
    expect(publicAttemptError(raw)).toBe(ATTEMPT_ERROR_GENERIC);
    expect(publicAttemptError(raw)).not.toContain("10.0.0.5");
  });
});
