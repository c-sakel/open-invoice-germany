// src/components/shell/Topbar.tsx
"use client";

import Link from "next/link";
import { useState } from "react";
import { NavIcon } from "./NavIcons";
import { SearchTrigger } from "./SearchTrigger";
import { Sidebar } from "./Sidebar";

interface Props {
  orgName: string;
  unreadCount: number;
}

/** Schmale Kopfleiste unterhalb `lg`: Burger oeffnet die Sidebar als Drawer. */
export function Topbar({ orgName, unreadCount }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 lg:hidden">
        <button type="button" aria-label="Menü" onClick={() => setOpen(true)} className="rounded-md p-1 text-slate-600 hover:bg-slate-100">
          <NavIcon name="menu" className="h-5 w-5" />
        </button>
        <Link href="/" className="font-semibold tracking-tight">
          OpenInvoice <span className="text-slate-400">DE</span>
        </Link>
        <div className="ml-auto">
          <SearchTrigger compact />
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Menü schließen" onClick={() => setOpen(false)} className="absolute inset-0 bg-slate-900/40" />
          <div className="absolute inset-y-0 left-0 shadow-xl">
            <Sidebar orgName={orgName} unreadCount={unreadCount} drawer onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
