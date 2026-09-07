import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { getCurrentUserId } from "@/lib/auth/server";
import { AppShell } from "@/components/shell/AppShell";
import { getActiveOrg } from "@/lib/org";
import { unreadCount } from "@/domain/notifications/create";
import { PUBLIC_NO_NAV_HEADER } from "@/proxy";

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
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-3xl items-center px-6 py-4">
              <span className="flex items-center gap-2 font-semibold tracking-tight">
                <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white">
                  OI
                </span>
                OpenInvoice <span className="text-slate-400">DE</span>
              </span>
            </div>
          </header>
          <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
          <footer className="mx-auto max-w-3xl px-6 py-10 text-xs text-slate-400">
            OpenInvoice Germany · AGPL-3.0
          </footer>
        </body>
      </html>
    );
  }

  const userId = await getCurrentUserId();
  const authed = Boolean(userId);

  if (!authed) {
    // Login/Setup: schlanke Huelle ohne Sidebar (wie bisher ohne MainNav)
    return (
      <html lang="de">
        <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
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
        <AppShell orgName={orgName} unreadCount={unread}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
