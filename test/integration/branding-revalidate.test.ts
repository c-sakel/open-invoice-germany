/** Speichern der Briefpapier-Einstellungen entwertet den Marken-Cache. Eigene Organisation, kein Belegjahr. */
import { describe, expect, it, vi } from "vitest";

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag, unstable_cache: <T,>(fn: T) => fn }));

import { dbInternal } from "@/lib/db";
import { saveBrandingSettings } from "@/domain/settings/branding";

describe("saveBrandingSettings", () => {
  it("ruft revalidateTag(brand:<orgId>)", async () => {
    const org = await dbInternal.organization.create({
      data: { legalName: "Marke Cache GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
      select: { id: true },
    });
    await saveBrandingSettings(org.id, { appName: "Neue Marke" });
    expect(revalidateTag).toHaveBeenCalledWith(`brand:${org.id}`, { expire: 0 });
  });
});
