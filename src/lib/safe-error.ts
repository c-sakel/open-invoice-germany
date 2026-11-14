/**
 * Fehler-Logs ohne personenbezogene Daten. Prisma-Validierungsfehler koennen die uebergebenen
 * Argumente (IBAN, Mandatsreferenz, Kartenangaben) im Text tragen; deshalb nie message/stack
 * von Prisma-Fehlern, bei sonstigen Fehlern nur name + message, wenn diese keine Ziffernfolge
 * ab 5 Stellen (auch mit Leerzeichen/Bindestrichen getrennt) enthaelt.
 */
export interface DescribedError {
  name: string;
  code?: string;
  message?: string;
}

const REDACTED = "[redigiert]";

function looksSensitive(message: string): boolean {
  if (/\d{5,}/.test(message.replace(/[\s-]/g, ""))) return true;
  return /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){3,}\b/.test(message);
}

export function describeError(e: unknown): DescribedError {
  if (!(e instanceof Error)) return { name: typeof e };
  const code = (e as { code?: unknown }).code;
  const prismaName = [e.name, e.constructor.name].find((n) => n.startsWith("Prisma"));
  const out: DescribedError = { name: prismaName ?? e.name };
  if (typeof code === "string") out.code = code;
  if (prismaName) return out;
  out.message = looksSensitive(e.message) ? REDACTED : e.message;
  return out;
}
