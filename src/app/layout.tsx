import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { getCurrentUserId } from "@/lib/auth/server";
import { AppShell } from "@/components/shell/AppShell";
import { SlimShell } from "@/components/shell/SlimShell";
import { getActiveOrg } from "@/lib/org";
import { unreadCount } from "@/domain/notifications/create";
import { PUBLIC_NO_NAV_HEADER } from "@/proxy";
import { dbInternal } from "@/lib/db";
import { loadBrand, DEFAULT_APP_NAME, DEFAULT_BRAND, type Brand } from "@/domain/settings/brand";
// `resolveJsonModule` ist in tsconfig.json aktiv — der JSON-Import wird beim Build inline
// gebundelt (kein Laufzeit-Dateizugriff im Docker-Runner noetig). `layout.tsx` ist eine
// Server-Komponente; die Version wird als Prop an die Client-Komponente `Sidebar` gereicht
// statt dort erneut importiert zu werden (Abschluss-Review M6).
import pkg from "@/../package.json";

/** Fuer AuthForm (Login-Seite) — dieselbe Selbstheilung wie unten im Rumpf: ohne
 *  Organisation (Setup-Zustand) gelten die Produktvorgaben. */
export async function safeBrand(): Promise<Brand> {
  try {
    return await loadBrand((await getActiveOrg()).id);
  } catch {
    return DEFAULT_BRAND;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  // Phase 12c: der Produktname ist ueberschreibbar (Einstellungen -> Marke). Ohne
  // Organisation (Setup-Zustand) gelten die Produktvorgaben — generateMetadata darf die
  // Seite nie reissen.
  let brand = DEFAULT_BRAND;
  let iconUrl = "/api/branding/icon";
  try {
    const org = await getActiveOrg();
    brand = await loadBrand(org.id);
    // Cache-Busting fuers Favicon: die Route selbst cacht 5 Minuten (Task 2); ein neuer
    // Upload soll trotzdem sofort sichtbar sein. `updatedAt` ist billig (indizierter
    // Unique-Key, eine Spalte) und steht nicht auf `Brand` (siehe test/unit/brand-schemas.test.ts).
    const row = await dbInternal.brandingSettings.findUnique({ where: { orgId: org.id }, select: { updatedAt: true } });
    if (row) iconUrl = `/api/branding/icon?v=${row.updatedAt.getTime()}`;
  } catch {
    // keine Organisation eingerichtet
  }
  const isDefault = brand.appName === DEFAULT_APP_NAME;
  return {
    title: isDefault ? `${DEFAULT_APP_NAME} — kostenlose, rechtssichere Rechnungssoftware` : brand.appName,
    applicationName: brand.appName,
    description:
      "Kostenlose, self-hostbare Open-Source-Rechnungssoftware für Deutschland: E-Rechnung (XRechnung/ZUGFeRD), GoBD, § 14 UStG, Kleinunternehmer § 19.",
    icons: { icon: iconUrl },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Öffentliche Seiten ohne Login (Angebotsannahme, Phase 3b): der Proxy markiert die
  // Anfrage per Request-Header, das Root-Layout rendert dann nur eine schlanke Hülle
  // ohne Navigation/Logout — kein Route-Group-Umbau nötig (Task-3-Addendum).
  const isPublic = (await headers()).get(PUBLIC_NO_NAV_HEADER) === "1";

  if (isPublic) {
    const brand = await safeBrand();
    return (
      <html lang="de">
        <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
          <SlimShell brand={brand} maxWidth="3xl">{children}</SlimShell>
        </body>
      </html>
    );
  }

  const userId = await getCurrentUserId();
  const authed = Boolean(userId);

  if (!authed) {
    // Login/Setup: schlanke Huelle ohne Sidebar (Abschluss-Review M7: Header/Footer wieder
    // wie vor der Sidebar-Einfuehrung — dieselbe SlimShell wie die oeffentliche Huelle oben).
    const brand = await safeBrand();
    return (
      <html lang="de">
        <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
          <SlimShell brand={brand}>{children}</SlimShell>
        </body>
      </html>
    );
  }

  // Org-Name + Ungelesen-Zaehler + Marke fuer die Sidebar; alle Aufrufe duerfen nicht die
  // Seite reissen (Setup-Zustand ohne Organisation): still auf Defaults. Der Org-Name
  // (nicht der Produktname) traegt die Sidebar-Zeile — ein leerer Wert blendet sie aus.
  let orgName = "";
  let unread = 0;
  let brand = DEFAULT_BRAND;
  try {
    const org = await getActiveOrg();
    orgName = org.legalName;
    unread = await unreadCount(org.id);
    brand = await loadBrand(org.id);
  } catch {
    // keine Organisation eingerichtet — Shell trotzdem rendern
  }

  return (
    <html lang="de">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <AppShell orgName={orgName} unreadCount={unread} appVersion={pkg.version} brand={brand}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
