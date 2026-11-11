/** Phase 16a Final-Fix — Batchgroesse des Archiv-Nachlaufs per Env ARCHIVE_JOB_BATCH. */
import { describe, expect, it } from "vitest";
import { ARCHIVE_BATCH, ARCHIVE_MAX_ATTEMPTS, archiveBatchFromEnv } from "@/domain/scheduler/archive-job";

describe("archiveBatchFromEnv", () => {
  it("gueltige Ganzzahl wird uebernommen", () => {
    expect(archiveBatchFromEnv("10")).toBe(10);
    expect(archiveBatchFromEnv(" 1 ")).toBe(1);
    expect(archiveBatchFromEnv(String(ARCHIVE_MAX_ATTEMPTS))).toBe(ARCHIVE_MAX_ATTEMPTS);
  });

  it("leer, ungueltig oder ausserhalb 1..ARCHIVE_MAX_ATTEMPTS -> Default", () => {
    for (const raw of [undefined, "", "0", "-5", "abc", "1.5", String(ARCHIVE_MAX_ATTEMPTS + 1)]) {
      expect(archiveBatchFromEnv(raw)).toBe(ARCHIVE_BATCH);
    }
  });
});
