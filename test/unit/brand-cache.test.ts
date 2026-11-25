import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBranding = vi.hoisted(() => vi.fn(async () => ({ appName: "Meine Marke", appShortName: "MM", appLogoPath: null })));
const revalidateTag = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/cache", () => ({
  revalidateTag,
  unstable_cache: <T,>(fn: () => Promise<T>, key: string[]) => async (): Promise<T> => {
    const k = key.join("|");
    if (!store.has(k)) store.set(k, await fn());
    return store.get(k) as T;
  },
}));
vi.mock("@/domain/settings/branding", async (orig) => ({ ...(await orig<typeof import("@/domain/settings/branding")>()), loadBrandingSettings: loadBranding }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: "org-1" }) }));

import { getOrgAndBrand } from "@/domain/settings/brand";

beforeEach(() => {
  store.clear();
  loadBranding.mockClear();
});

describe("Marke gecacht", () => {
  it("zwei getrennte Durchlaeufe laden die Marke einmal", async () => {
    const a = await getOrgAndBrand();
    const b = await getOrgAndBrand();
    expect(a?.brand.appName).toBe("Meine Marke");
    expect(b?.brand).toEqual(a?.brand);
    expect(loadBranding).toHaveBeenCalledTimes(1);
  });
});
