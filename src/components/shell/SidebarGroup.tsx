// src/components/shell/SidebarGroup.tsx
"use client";

import Link from "next/link";
import type { NavGroup, NavItem } from "@/lib/nav";
import { itemMatches, SETTINGS_ITEMS } from "@/lib/nav";
import { NavIcon } from "./NavIcons";

interface Props {
  group: NavGroup;
  pathname: string;
  search: string;
  collapsed: boolean;
  unreadCount: number;
  onNavigate?: () => void;
}

function ItemLink({ item, active, collapsed, badge, onNavigate, indent }: { item: NavItem; active: boolean; collapsed: boolean; badge: number; onNavigate?: () => void; indent?: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-2.5 rounded-md py-1.5 text-sm ${indent ? "pl-9 pr-2" : "px-2"} ${
        active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      {item.icon && <NavIcon name={item.icon} className="h-4 w-4 shrink-0" />}
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && item.badge === "notifications" && badge > 0 && (
        <span className="ml-auto rounded-full bg-indigo-600 px-1.5 text-[10px] font-semibold text-white">{badge}</span>
      )}
      {collapsed && item.badge === "notifications" && badge > 0 && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-indigo-600" aria-label={`${badge} ungelesen`} />
      )}
    </Link>
  );
}

export function SidebarGroup({ group, pathname, search, collapsed, unreadCount, onNavigate }: Props) {
  if (group.href !== undefined && group.items.length === 0) {
    return (
      <ItemLink
        item={{ href: group.href, label: group.label, icon: group.icon, exact: true }}
        active={pathname === group.href}
        collapsed={collapsed}
        badge={0}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <div className="space-y-0.5">
      {!collapsed && <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</div>}
      {collapsed && <div className="my-2 border-t border-slate-200" />}
      {group.items.map((item) => {
        const isActive = itemMatches(item, pathname, search);
        const showSettings = item.href === "/einstellungen" && isActive && !collapsed;
        return (
          <div key={item.href}>
            <ItemLink item={item} active={isActive} collapsed={collapsed} badge={unreadCount} onNavigate={onNavigate} />
            {showSettings && (
              <div className="mt-0.5 space-y-0.5">
                {SETTINGS_ITEMS.map((s) => (
                  <ItemLink key={s.href} item={s} active={itemMatches(s, pathname, search)} collapsed={false} badge={0} onNavigate={onNavigate} indent />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
