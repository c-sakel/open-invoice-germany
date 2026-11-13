/**
 * Postversand: ChangeLog-Appends einer Organisation serialisieren.
 *
 * Die Hash-Kette (`@@unique([orgId, prevHash])`) erlaubt je Organisation nur einen gleichzeitigen Append;
 * parallele Postversand-Transaktionen (Uebertragung, Abgleich, Storno) wuerden sonst mit P2002 kollidieren
 * und Buchungen nach bereits erfolgter Uebertragung verlieren. Deshalb sperrt jeder Postversand-Append
 * zuerst die PostalSettings-Zeile der Organisation (dieselbe Sperre wie bei der Auftragsanlage; Reihenfolge
 * Einstellungen vor Beleg). Die Sperre haelt bis zum Transaktionsende. Unter SQLite No-op (serialisiert ohnehin).
 */
import type { Prisma } from "@/generated/prisma/client";
import { appendChangeLog, type ChangeLogInput } from "@/domain/audit";
import { lockRow } from "@/lib/db-lock";

export async function appendPostalChangeLog(tx: Prisma.TransactionClient, input: ChangeLogInput) {
  const settings = await tx.postalSettings.upsert({ where: { orgId: input.orgId }, create: { orgId: input.orgId }, update: {}, select: { id: true } });
  await lockRow(tx, "PostalSettings", settings.id, input.orgId);
  return appendChangeLog(tx, input);
}
