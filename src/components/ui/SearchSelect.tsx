"use client";

/**
 * Such-Auswahl (ARIA-Combobox) fuer grosse Bestaende: clientseitig ueber `options`
 * oder serverseitig ueber `search` (Debounce 200 ms, laufende Anfrage wird per
 * AbortController abgebrochen). Leere Eingabe zeigt „Zuletzt verwendet“ (localStorage,
 * ueber `loadByIds` nachgeladen) bzw. die ersten Optionen. Die Liste haengt per Portal
 * an `document.body` (nie abgeschnitten), unter 640 px als Bottom-Sheet.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FloatingPanel } from "@/components/ui/FloatingPanel";
import { inputCls } from "@/components/forms/fields";
import { useRecent } from "@/components/ui/use-recent";

export type SearchSelectOption = { id: string; label: string; subtitle?: string };
type Option = SearchSelectOption;

export interface SearchSelectProps {
  value: string | null;
  /**
   * Auswahl uebernehmen. Liefert der Aufrufer `false` (auch asynchron, z. B. abgelehnte Auswahl) oder wirft er,
   * gilt die Auswahl als nicht angenommen und kommt nicht unter „Zuletzt verwendet“.
   */
  onChange: (id: string | null, option: Option | null) => void | boolean | Promise<void | boolean>;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Name des versteckten Eingabefelds (Formular-Submit). */
  name?: string;
  /** Clientseitige Optionen (< 50). */
  options?: Option[];
  /** Serverseitige Suche. */
  search?: (q: string, signal: AbortSignal) => Promise<Option[]>;
  loadSelected?: (id: string) => Promise<Option | null>;
  recentKey?: string;
  loadByIds?: (ids: string[]) => Promise<Option[]>;
  onCreate?: { label: string; run: (q: string) => void };
  /** Eintrag zum Leeren, z. B. „— keiner —“. */
  emptyOptionLabel?: string;
}

type Item = { kind: "empty" } | { kind: "option"; option: Option } | { kind: "create" };

const DEBOUNCE_MS = 200;
const MAX_LOCAL_HITS = 50;

function matches(o: Option, q: string): boolean {
  const needle = q.toLowerCase();
  return o.label.toLowerCase().includes(needle) || (o.subtitle ?? "").toLowerCase().includes(needle);
}

export function SearchSelect({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  required,
  name,
  options,
  search,
  loadSelected,
  recentKey,
  loadByIds,
  onCreate,
  emptyOptionLabel,
}: SearchSelectProps) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [remote, setRemote] = useState<Option[]>([]);
  const [recentOptions, setRecentOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<Option | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-${i}`;
  const recent = useRecent(recentKey);

  const q = query.trim();

  // Gewaehlte Option: aus options/Treffern ableiten, sonst per loadSelected nachladen.
  const known = useMemo(
    () => (value === null ? null : (options?.find((o) => o.id === value) ?? remote.find((o) => o.id === value) ?? recentOptions.find((o) => o.id === value) ?? null)),
    [value, options, remote, recentOptions],
  );
  const selected: Option | null = value === null ? null : (known ?? (loaded?.id === value ? loaded : null));
  const needsLoad = value !== null && known === null && loaded?.id !== value;
  useEffect(() => {
    if (!needsLoad || !loadSelected || value === null) return;
    let alive = true;
    loadSelected(value)
      .then((o) => {
        if (alive && o) setLoaded(o);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [needsLoad, value, loadSelected]);

  // Suche (Debounce + Abbruch) bzw. „Zuletzt verwendet“ bei leerer Eingabe.
  useEffect(() => {
    abortRef.current?.abort();
    if (!open) return;
    if (q === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Ladezustand der externen Abfrage folgt Eingabe/Panel
      setLoading(false);
      setRemote([]);
      const ids = recent.reload();
      const controller = new AbortController();
      abortRef.current = controller;
      // Ohne zuletzt verwendete Eintraege: die ersten Treffer der Suche (leerer Suchtext).
      const firstEntries = () => {
        if (!search) {
          setLoading(false);
          return;
        }
        setLoading(true);
        search("", controller.signal)
          .then((found) => {
            if (controller.signal.aborted) return;
            setRemote(found);
            setLoading(false);
          })
          .catch(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      };
      if (!loadByIds || ids.length === 0) {
        setRecentOptions([]);
        firstEntries();
        return;
      }
      setLoading(true);
      loadByIds(ids)
        .then((found) => {
          if (controller.signal.aborted) return;
          const byId = new Map(found.map((o) => [o.id, o]));
          const list = ids.map((id) => byId.get(id)).filter((o): o is Option => o !== undefined);
          setRecentOptions(list);
          if (list.length === 0) firstEntries();
          else setLoading(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) firstEntries();
        });
      return;
    }
    setRecentOptions([]);
    if (!search) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const timer = setTimeout(() => {
      search(q, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setRemote(found);
          setLoading(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setRemote([]);
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, search, loadByIds, recentKey]);

  const shown: Option[] = useMemo(() => {
    if (q === "") {
      if (recentOptions.length > 0) return recentOptions;
      if (options) return options.slice(0, MAX_LOCAL_HITS);
      return remote;
    }
    if (options) return options.filter((o) => matches(o, q)).slice(0, MAX_LOCAL_HITS);
    return remote;
  }, [q, options, remote, recentOptions]);

  const showRecentHeading = q === "" && recentOptions.length > 0;

  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    if (emptyOptionLabel && q === "") list.push({ kind: "empty" });
    for (const option of shown) list.push({ kind: "option", option });
    if (onCreate && q !== "") list.push({ kind: "create" });
    return list;
  }, [emptyOptionLabel, q, shown, onCreate]);

  const safeCursor = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);

  const close = useCallback(() => {
    setOpen(false);
    setEditing(false);
    setQuery("");
  }, []);

  function choose(item: Item) {
    if (item.kind === "empty") {
      onChange(null, null);
    } else if (item.kind === "option") {
      setLoaded(item.option);
      const picked = item.option.id;
      const accepted = (result: void | boolean) => {
        if (result !== false) recent.push(picked);
      };
      try {
        const result = onChange(picked, item.option);
        if (result instanceof Promise) result.then(accepted, () => undefined);
        else accepted(result);
      } catch (e) {
        close();
        throw e;
      }
    } else {
      onCreate?.run(q);
    }
    close();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setCursor(Math.min(safeCursor + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(safeCursor - 1, 0));
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setCursor(Math.max(items.length - 1, 0));
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      // Läuft die Suche zum getippten Text noch, zeigt die Liste Treffer der vorigen Eingabe: nicht wählen.
      if (loading && q !== "" && !options) return;
      const item = items[safeCursor];
      if (item) choose(item);
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      close(); // Fokus bleibt im Feld
    } else if (e.key === "Tab") {
      close();
    }
  }

  const status = loading ? "Lädt…" : open && shown.length === 0 && q !== "" ? "Keine Treffer" : "";
  const inputValue = editing ? query : (selected?.label ?? "");

  return (
    <div ref={anchorRef} className="relative">
      {name && <input type="hidden" name={name} value={value ?? ""} />}
      <input
        ref={inputRef}
        className={`${inputCls} w-full`}
        aria-label={label}
        placeholder={placeholder}
        value={inputValue}
        disabled={disabled}
        required={required && !name}
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && items[safeCursor] ? optionId(safeCursor) : undefined}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setEditing(true);
          setQuery(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div aria-live="polite" className="sr-only">
        {status}
      </div>
      <FloatingPanel
        anchorRef={anchorRef}
        open={open && !disabled}
        onClose={close}
        matchAnchorWidth
        sheetOnMobile
        role="listbox"
        id={listboxId}
        aria-label={label}
        className="rounded-md border border-rule bg-sheet text-sm shadow-lg"
      >
        {showRecentHeading && <div className="px-3 pt-2 text-xs font-medium text-ink-muted">Zuletzt verwendet</div>}
        {loading && items.length === 0 && <div aria-hidden="true" className="px-3 py-2 text-ink-muted">Lädt…</div>}
        {!loading && items.length === 0 && q !== "" && <div aria-hidden="true" className="px-3 py-2 text-ink-muted">Keine Treffer</div>}
        {items.map((item, i) => (
          <div key={item.kind === "option" ? item.option.id : item.kind} id={optionId(i)} role="option" aria-selected={i === safeCursor}>
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(item)}
              className={`flex min-h-11 w-full flex-col justify-center px-3 py-1.5 text-left ${i === safeCursor ? "bg-pen-wash text-pen" : "hover:bg-paper"}`}
            >
              {item.kind === "empty" && <span>{emptyOptionLabel}</span>}
              {item.kind === "create" && <span className="font-medium">{`+ ${onCreate?.label} „${q}“`}</span>}
              {item.kind === "option" && (
                <>
                  <span className="font-medium">{item.option.label}</span>
                  {item.option.subtitle && <span className="text-xs text-ink-muted">{item.option.subtitle}</span>}
                </>
              )}
            </button>
          </div>
        ))}
      </FloatingPanel>
    </div>
  );
}
