/**
 * Task 7 (Spec R11): CMYK-JPEG-Logos/-Hintergruende wuerden `DeviceCMYK` ohne passenden
 * OutputIntent ins PDF bringen und PDF/A brechen — der Upload lehnt sie ab.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { testPngBuffer, testJpegBuffer } from "../helpers/pdf-theme";
import { POST } from "@/app/api/settings/branding/upload/route";

let orgId: string;
vi.mock("@/lib/org", () => ({ getActiveOrg: () => Promise.resolve({ id: orgId }) }));

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "CMYK Test GmbH", addressLine1: "Farbweg 1", postalCode: "10115", city: "Berlin" },
  });
  orgId = org.id;
});

function upload(kind: string, buf: Buffer, name: string, mime: string) {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(buf)], name, { type: mime }));
  // FormData-Bodies liefern in dieser Umgebung keinen automatischen content-length-Header
  // (siehe settings-routes.test.ts) — die Route braucht ihn fuer die Vorpruefung.
  return new Request(`http://x/api/settings/branding/upload?kind=${kind}`, { method: "POST", body: fd, headers: { "content-length": "100" } });
}

describe("Branding-Upload: CMYK-JPEG-Sperre (Logo/Hintergrund)", () => {
  it("CMYK-JPEG (4 Komponenten) als Logo -> 400, kein Pfad gespeichert", async () => {
    const res = await upload("logo", testJpegBuffer(4), "logo.jpg", "image/jpeg");
    expect((await POST(res)).status).toBe(400);
    expect((await dbInternal.brandingSettings.findUnique({ where: { orgId } }))?.logoPath ?? null).toBeNull();
  });

  it("CMYK-JPEG (4 Komponenten) als Hintergrund -> 400", async () => {
    expect((await POST(upload("background", testJpegBuffer(4), "bg.jpg", "image/jpeg"))).status).toBe(400);
  });

  it("RGB-JPEG (3 Komponenten) als Logo -> 201, Pfad gespeichert", async () => {
    const res = await POST(upload("logo", testJpegBuffer(3), "logo.jpg", "image/jpeg"));
    expect(res.status).toBe(201);
    expect((await dbInternal.brandingSettings.findUnique({ where: { orgId } }))?.logoPath).toBeTruthy();
  });

  it("RGB-PNG als Logo bleibt erlaubt (keine JPEG-Komponentenpruefung fuer PNG)", async () => {
    expect((await POST(upload("logo", testPngBuffer(64, 32), "logo.png", "image/png"))).status).toBe(201);
  });
});
