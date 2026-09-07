// src/components/shell/Sidebar.tsx
"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { NAV_GROUPS, activeGroupKey } from "@/lib/nav";
import { LogoutButton } from "@/components/LogoutButton";
import { NavIcon } from "./NavIcons";
import { SidebarGroup } from "./SidebarGroup";

const COLLAPSED_KEY = "oig.sidebar.collapsed";

interface Props {
  orgName: string;
  unreadCount: number;
  /** Suchfeld/Befehlspalette (Task 5); bis dahin ein Link auf /rechnungen?q= */
  searchSlot?: ReactNode;
  /** Drawer-Modus (mobil): Sidebar liegt als Overlay, Klick auf Link schliesst. */
  drawer?: boolean;
  onClose?: () => void;
}

export function Sidebar({ orgName, unreadCount, searchSlot, drawer = false, onClose }: Props) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const searchStr = search ? `?${search}` : "";
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // localStorage nur im Effekt (SSR-sicher); setState per setTimeout(0) wie NotificationBell.
    const t = setTimeout(() => {
      try {
        setCollapsed(!drawer && localStorage.getItem(COLLAPSED_KEY) === "1");
      } catch {
        // kein Storage (privater Modus) — ausgeklappt bleiben
      }
    }, 0);
    return () => clearTimeout(t);
  }, [drawer]);

  function toggleCollapsed() {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
      } catch {
        // ignorieren
      }
      return !v;
    });
  }

  const activeKey = activeGroupKey(pathname, searchStr);
  const width = collapsed ? "w-14" : "w-60";

  return (
    <aside className={`flex h-full ${width} shrink-0 flex-col border-r border-slate-200 bg-white transition-[width]`} aria-label="Hauptnavigation">
      <div className="flex items-center gap-2 px-3 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" onClick={onClose}>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white">OI</span>
          {!collapsed && (
            <span>
              OpenInvoice <span className="text-slate-400">DE</span>
            </span>
          )}
        </Link>
        {drawer && (
          <button type="button" aria-label="Menü schließen" onClick={onClose} className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <NavIcon name="close" />
          </button>
        )}
      </div>

      {!collapsed && <div className="px-3 pb-2">{searchSlot}</div>}

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((g) => (
          <SidebarGroup key={g.key} group={g} pathname={pathname} search={searchStr} active={activeKey === g.key} collapsed={collapsed} unreadCount={unreadCount} onNavigate={onClose} />
        ))}
      </nav>

      <div className="border-t border-slate-200 px-3 py-3 text-xs text-slate-500">
        {!collapsed && (
          <div className="mb-2 truncate font-medium text-slate-700" title={orgName}>
            {orgName}
          </div>
        )}
        <div className="flex items-center justify-between">
          {!collapsed && <LogoutButton />}
          {!drawer && (
            <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? "Navigation ausklappen" : "Navigation einklappen"} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
              <NavIcon name={collapsed ? "menu" : "close"} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
