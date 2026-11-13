// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NavGroup } from "@/lib/nav";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SidebarGroup } from "@/components/shell/SidebarGroup";

const GROUP: NavGroup = { key: "sync-a", label: "Gruppe A", icon: "invoice", items: [{ href: "/a-eins", label: "Eintrag A1" }] };
const OTHER: NavGroup = { key: "sync-b", label: "Gruppe B", icon: "invoice", items: [{ href: "/b-eins", label: "Eintrag B1" }] };

function group(g: NavGroup) {
  return <SidebarGroup group={g} pathname="/nichts" search="" collapsed={false} unreadCount={0} />;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SidebarGroup-Abgleich", () => {
  it("Toggle in Instanz A schliesst auch Instanz B", async () => {
    render(
      <>
        <div data-testid="a">{group(GROUP)}</div>
        <div data-testid="b">{group(GROUP)}</div>
      </>,
    );
    await settle();
    expect(screen.getAllByText("Eintrag A1")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /Gruppe A/ })[0]);
    expect(screen.queryAllByText("Eintrag A1")).toHaveLength(0);
  });

  it("storage-Event mit newValue 0 schliesst beide", async () => {
    render(
      <>
        {group(GROUP)}
        {group(GROUP)}
      </>,
    );
    await settle();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "oig.nav.open.sync-a", newValue: "0" }));
    });
    expect(screen.queryAllByText("Eintrag A1")).toHaveLength(0);
  });

  it("Event einer anderen Gruppe aendert nichts", async () => {
    render(
      <>
        {group(GROUP)}
        {group(OTHER)}
      </>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Gruppe B/ }));
    expect(screen.queryAllByText("Eintrag B1")).toHaveLength(0);
    expect(screen.getAllByText("Eintrag A1")).toHaveLength(1);
  });

  it("ohne localStorage kein Absturz", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("kein Storage");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("kein Storage");
    });
    render(group(GROUP));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Gruppe A/ }));
    expect(screen.queryAllByText("Eintrag A1")).toHaveLength(0);
  });
});
