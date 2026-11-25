import { createHash } from "node:crypto";

/**
 * Hash einer Message-Id: ohne Spitzklammern, kleingeschrieben, SHA-256 (hex). Gleiche Normalisierung wie
 * im Mail-Worker (src/workers/mail-worker.mjs); ein Test vergleicht beide.
 */
export function messageIdHash(id: string | null): string | null {
  if (typeof id !== "string") return null;
  const s = id.trim().replace(/^<|>$/g, "").toLowerCase();
  return s === "" ? null : createHash("sha256").update(s).digest("hex");
}
