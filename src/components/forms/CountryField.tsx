"use client";

import { useMemo, useState } from "react";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { countryOptions } from "@/lib/countries";

/**
 * Laenderauswahl (Suche nach deutschem Namen oder ISO-Code). Gespeichert wird der ISO-2-Code ueber ein
 * verstecktes Feld `name`. Ein Bestandswert ausserhalb der Liste bleibt sichtbar und erhalten, bis bewusst ein anderes Land gewaehlt wird.
 */
export function CountryField({ label, name, defaultValue, emptyOptionLabel }: { label: string; name: string; defaultValue?: string | null; emptyOptionLabel?: string }) {
  const initial = (defaultValue ?? "").trim();
  const [value, setValue] = useState<string | null>(initial === "" ? null : initial);
  const options = useMemo(() => countryOptions(initial), [initial]);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink-soft">{label}</span>
      <SearchSelect label={label} name={name} value={value} options={options} emptyOptionLabel={emptyOptionLabel} placeholder="Land suchen…" onChange={(id) => setValue(id)} />
    </div>
  );
}
