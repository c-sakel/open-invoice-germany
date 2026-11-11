/**
 * CLI: Hash-Kette des Aenderungsprotokolls pruefen (Phase 16a).
 *   npx tsx scripts/verify-chain.ts [--org <id>]
 * Ausgabe je Organisation `OK <orgId> <entries>` bzw. `FEHLER <orgId> broken=<id>`; Exit 1 bei Bruch.
 */
import { dbInternal } from "../src/lib/db";
import { verifyOrgChain } from "../src/domain/audit/verify-chain";

async function main() {
  const idx = process.argv.indexOf("--org");
  const only = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (idx >= 0 && !only) {
    console.error("--org erwartet eine Organisations-ID");
    process.exitCode = 2;
    return;
  }
  const orgs = await dbInternal.organization.findMany({
    where: only ? { id: only } : undefined,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (only && orgs.length === 0) {
    console.error(`FEHLER ${only} unbekannte Organisation`);
    process.exitCode = 2;
    return;
  }
  for (const org of orgs) {
    const r = await verifyOrgChain(org.id, "CLI");
    if (r.valid) console.log(`OK ${org.id} ${r.entries}`);
    else {
      console.log(`FEHLER ${org.id} broken=${r.brokenEntryId}`);
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error("Kettenpruefung fehlgeschlagen:", e);
    process.exitCode = 1;
  })
  .finally(() => dbInternal.$disconnect());
