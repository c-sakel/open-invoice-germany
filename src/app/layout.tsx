import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { getCurrentUserId } from "@/lib/auth/server";
import { AppShell } from "@/components/shell/AppShell";
import { SlimShell } from "@/components/shell/SlimShell";
import { getActiveOrg } from "@/lib/org";
import { unreadCount } from "@/domain/notifications/create";
import { PUBLIC_NO_NAV_HEADER } from "@/proxy";
// `resolveJsonModule` ist in tsconfig.json aktiv — der JSON-Import wird beim Build inline
// gebundelt (kein Laufzeit-Dateizugriff im Docker-Runner noetig). `layout.tsx` ist eine
// Server-Komponente; die Version wird als Prop an die Client-Komponente `Sidebar` gereicht
// statt dort erneut importiert zu werden (Abschluss-Review M6).
import pkg from "@/../package.json";

export const metadata: Metadata = {
  title: "OpenInvoice Germany — kostenlose, rechtssichere Rechnungssoftware",
  description:
    "Kostenlose, self-hostbare Open-Source-Rechnungssoftware für Deutschland: E-Rechnung (XRechnung/ZUGFeRD), GoBD, § 14 UStG, Kleinunternehmer § 19.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Öffentliche Seiten ohne Login (Angebotsannahme, Phase 3b): der Proxy markiert die
  // Anfrage per Request-Header, das Root-Layout rendert dann nur eine schlanke Hülle
  // ohne Navigation/Logout — kein Route-Group-Umbau nötig (Task-3-Addendum).
  const isPublic = (await headers()).get(PUBLIC_NO_NAV_HEADER) === "1";

  if (isPublic) {
    return (
      <html lang="de">
        <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
          <SlimShell maxWidth="3xl">{children}</SlimShell>
        </body>
      </html>
    );
  }

  const userId = await getCurrentUserId();
  const authed = Boolean(userId);

  if (!authed) {
    // Login/Setup: schlanke Huelle ohne Sidebar (Abschluss-Review M7: Header/Footer wieder
    // wie vor der Sidebar-Einfuehrung — dieselbe SlimShell wie die oeffentliche Huelle oben).
    return (
      <html lang="de">
        <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
          <SlimShell>{children}</SlimShell>
        </body>
      </html>
    );
  }

  // Org-Name + Ungelesen-Zaehler fuer die Sidebar; beide Aufrufe duerfen nicht die Seite
  // reissen (Setup-Zustand ohne Organisation): still auf Defaults.
  let orgName = "OpenInvoice";
  let unread = 0;
  try {
    const org = await getActiveOrg();
    orgName = org.legalName;
    unread = await unreadCount(org.id);
  } catch {
    // keine Organisation eingerichtet — Shell trotzdem rendern
  }

  return (
    <html lang="de">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <AppShell orgName={orgName} unreadCount={unread} appVersion={pkg.version}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
