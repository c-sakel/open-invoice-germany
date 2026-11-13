import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { classifyCancelError } from "@/domain/invoice/bulk-cancel";
import { CancelError } from "@/domain/invoice/cancel";
import { NotFoundError } from "@/domain/errors";
import { FinalizeError } from "@/domain/invoice/finalize-error";

describe("classifyCancelError", () => {
  it("CancelError -> NOT_CANCELLABLE mit Originaltext", () => {
    expect(classifyCancelError(new CancelError("Rechnung ist bereits storniert."))).toEqual({ code: "NOT_CANCELLABLE", message: "Rechnung ist bereits storniert.", retryable: false });
  });
  it("NotFoundError -> NOT_FOUND mit neutralem Text", () => {
    expect(classifyCancelError(new NotFoundError("irgendwas intern"))).toEqual({ code: "NOT_FOUND", message: "Rechnung nicht gefunden.", retryable: false });
  });
  it("FinalizeError -> FINALIZE_FAILED", () => {
    const c = classifyCancelError(new FinalizeError("Pflichtangabe fehlt"));
    expect(c.code).toBe("FINALIZE_FAILED");
    expect(c.retryable).toBe(false);
  });
  it("P2002 -> BUSY, wiederholbar", () => {
    const e = new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x", meta: { target: ["orgId", "prevHash"] } });
    const c = classifyCancelError(e);
    expect(c.code).toBe("BUSY");
    expect(c.retryable).toBe(true);
  });
  it("unbekannter Fehler -> INTERNAL ohne Details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = classifyCancelError(new Error("SQLITE intern xyz"));
    spy.mockRestore();
    expect(c.code).toBe("INTERNAL");
    expect(c.message).toBe("Storno fehlgeschlagen — Details im Serverprotokoll.");
    expect(c.message).not.toContain("xyz");
    expect(c.retryable).toBe(false);
  });
});
