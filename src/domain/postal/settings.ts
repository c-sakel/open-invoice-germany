/**
 * Phase 16d — Einstellungen Postversand (je Organisation, eine Zeile `PostalSettings`).
 *
 * - Zugangsdaten: Benutzername im Klartext, API-Schluessel nur verschluesselt (POSTAL_KEY_PURPOSE);
 *   die View enthaelt nie den Klartext, nur "hinterlegt" und die letzten 4 Zeichen.
 * - Speichern merged mit dem gespeicherten Stand: nur uebergebene Felder aendern sich
 *   (kein Schema-Default, der einen Schalter zuruecksetzen koennte).
 * - Quelle API/MCP darf ausschliesslich die Druckoptionen setzen.
 * - Echtes Netz wird hier nie benoetigt; der Verbindungstest liegt in connection.ts.
 */
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { decryptSecret, encryptSecret, POSTAL_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { lockRow } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import {
  postalPrintOptionsSchema,
  postalSettingsUiSchema,
  type PostalMode,
  type PostalSettingsUiInput,
} from "@/schemas/postal";
import type { LxpCredentials } from "@/lib/postal/letterxpress";

export class PostalNotConfiguredError extends Error {
  constructor() {
    super("Postversand ist nicht eingerichtet (Benutzername oder API-Schluessel fehlt).");
    this.name = "PostalNotConfiguredError";
  }
}

export class PostalDisabledError extends Error {
  constructor() {
    super("Postversand ist nicht aktiviert.");
    this.name = "PostalDisabledError";
  }
}

export class PostalKeyUnreadableError extends Error {
  constructor() {
    super("Schluessel nicht lesbar (AUTH_SECRET gewechselt?)");
    this.name = "PostalKeyUnreadableError";
  }
}

export interface PostalSettingsView {
  provider: "LETTERXPRESS";
  username: string | null;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  enabled: boolean;
  mode: PostalMode;
  autoDunningPost: boolean;
  color: "1" | "4";
  duplex: boolean;
  shipping: "auto" | "national" | "international";
  registeredDefault: "r1" | "r2" | null;
  monthlyBudgetCents: number | null;
  lastBalanceCents: number | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  effective: "OFF_DRY_RUN" | "DRY_RUN" | "TEST" | "LIVE";
}

const SELECT = {
  id: true,
  username: true,
  apiKeyEnc: true,
  enabled: true,
  mode: true,
  autoDunningPost: true,
  color: true,
  duplex: true,
  shipping: true,
  registeredDefault: true,
  monthlyBudgetCents: true,
  lastBalanceCents: true,
  lastTestAt: true,
  lastTestOk: true,
  lastTestError: true,
} as const;

interface Row {
  id: string;
  username: string | null;
  apiKeyEnc: string | null;
  enabled: boolean;
  mode: string;
  autoDunningPost: boolean;
  color: string;
  duplex: boolean;
  shipping: string;
  registeredDefault: string | null;
  monthlyBudgetCents: number | null;
  lastBalanceCents: number | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

const DEFAULT_ROW: Row = {
  id: "",
  username: null,
  apiKeyEnc: null,
  enabled: false,
  mode: "DRY_RUN",
  autoDunningPost: false,
  color: "1",
  duplex: false,
  shipping: "auto",
  registeredDefault: null,
  monthlyBudgetCents: null,
  lastBalanceCents: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
};

function asMode(v: string): PostalMode {
  return v === "TEST" || v === "LIVE" ? v : "DRY_RUN";
}

export function effectiveMode(enabled: boolean, mode: PostalMode): PostalSettingsView["effective"] {
  return enabled ? mode : "OFF_DRY_RUN";
}

function last4(enc: string): string | null {
  try {
    const key = decryptSecret(enc, POSTAL_KEY_PURPOSE);
    return key.length >= 12 ? key.slice(-4) : null;
  } catch {
    return null;
  }
}

function toView(row: Row): PostalSettingsView {
  const mode = asMode(row.mode);
  return {
    provider: "LETTERXPRESS",
    username: row.username,
    hasApiKey: row.apiKeyEnc !== null,
    apiKeyLast4: row.apiKeyEnc ? last4(row.apiKeyEnc) : null,
    enabled: row.enabled,
    mode,
    autoDunningPost: row.autoDunningPost,
    color: row.color === "4" ? "4" : "1",
    duplex: row.duplex,
    shipping: row.shipping === "national" || row.shipping === "international" ? row.shipping : "auto",
    registeredDefault: row.registeredDefault === "r1" || row.registeredDefault === "r2" ? row.registeredDefault : null,
    monthlyBudgetCents: row.monthlyBudgetCents,
    lastBalanceCents: row.lastBalanceCents,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    effective: effectiveMode(row.enabled, mode),
  };
}

export async function loadPostalSettings(orgId: string): Promise<PostalSettingsView> {
  const row = await dbInternal.postalSettings.findUnique({ where: { orgId }, select: SELECT });
  return toView(row ?? DEFAULT_ROW);
}

/** Nur server-intern. null: nicht eingerichtet. Wirft PostalKeyUnreadableError, wenn der Schluessel nicht entschluesselbar ist. */
export async function loadPostalCredentials(orgId: string): Promise<LxpCredentials | null> {
  const row = await dbInternal.postalSettings.findUnique({
    where: { orgId },
    select: { username: true, apiKeyEnc: true, mode: true },
  });
  if (!row?.username || !row.apiKeyEnc) return null;
  let apiKey: string;
  try {
    apiKey = decryptSecret(row.apiKeyEnc, POSTAL_KEY_PURPOSE);
  } catch {
    throw new PostalKeyUnreadableError();
  }
  return { username: row.username, apiKey, mode: row.mode === "LIVE" ? "live" : "test" };
}

function costsError(): ZodError {
  return new ZodError([
    {
      code: "custom",
      path: ["acknowledgeCosts"],
      message: "Der Versand uebertraegt Daten an einen Dritten und kann Kosten verursachen; er muss bestaetigt werden.",
    },
  ]);
}

export async function savePostalSettings(
  orgId: string,
  raw: unknown,
  ctx: { actor: string; source: "UI" | "API" | "MCP" },
): Promise<PostalSettingsView> {
  const input: PostalSettingsUiInput =
    ctx.source === "UI" ? postalSettingsUiSchema.parse(raw) : postalPrintOptionsSchema.parse(raw);

  // Verschluesseln VOR der Transaktion: ohne AUTH_SECRET wird nichts gespeichert.
  const newKeyEnc = input.apiKey !== undefined ? encryptSecret(input.apiKey, POSTAL_KEY_PURPOSE) : undefined;

  const saved = await dbInternal.$transaction(async (tx) => {
    // Zeile sicherstellen und sperren (Postgres: FOR UPDATE; SQLite serialisiert Schreibtransaktionen),
    // dann erst lesen: parallele Speicherungen sehen den Stand der jeweils vorherigen.
    const ensured = await tx.postalSettings.upsert({
      where: { orgId },
      create: { orgId },
      update: {},
      select: { id: true },
    });
    await lockRow(tx, "PostalSettings", ensured.id, orgId);
    const base: Row = await tx.postalSettings.findUniqueOrThrow({ where: { orgId }, select: SELECT });

    const next = {
      username: input.username ?? base.username,
      apiKeyEnc: base.apiKeyEnc,
      enabled: input.enabled ?? base.enabled,
      mode: input.mode ?? asMode(base.mode),
      autoDunningPost: input.autoDunningPost ?? base.autoDunningPost,
      color: input.color ?? base.color,
      duplex: input.duplex ?? base.duplex,
      shipping: input.shipping ?? base.shipping,
      registeredDefault: input.registeredDefault !== undefined ? input.registeredDefault : base.registeredDefault,
      monthlyBudgetCents: input.monthlyBudgetCents !== undefined ? input.monthlyBudgetCents : base.monthlyBudgetCents,
    };

    // Bestaetigung (Datenuebertragung an Dritte, ggf. Kosten) bei jedem Wechsel von
    // {aus, Probelauf} nach {TEST, LIVE}.
    const was = effectiveMode(base.enabled, asMode(base.mode));
    const will = effectiveMode(next.enabled, next.mode);
    const wasSending = was === "TEST" || was === "LIVE";
    const willSend = will === "TEST" || will === "LIVE";
    if (willSend && !wasSending && input.acknowledgeCosts !== true) throw costsError();

    if (input.clearApiKey) next.apiKeyEnc = null;
    if (newKeyEnc !== undefined) next.apiKeyEnc = newKeyEnc;

    const changed: string[] = [];
    const cmp: [string, unknown, unknown][] = [
      ["username", base.username, next.username],
      ["apiKey", base.apiKeyEnc !== null, next.apiKeyEnc !== null],
      ["enabled", base.enabled, next.enabled],
      ["mode", asMode(base.mode), next.mode],
      ["autoDunningPost", base.autoDunningPost, next.autoDunningPost],
      ["color", base.color, next.color],
      ["duplex", base.duplex, next.duplex],
      ["shipping", base.shipping, next.shipping],
      ["registeredDefault", base.registeredDefault, next.registeredDefault],
      ["monthlyBudgetCents", base.monthlyBudgetCents, next.monthlyBudgetCents],
    ];
    for (const [name, a, b] of cmp) if (a !== b) changed.push(name);
    if (newKeyEnc !== undefined && !changed.includes("apiKey")) changed.push("apiKey"); // Schluessel ersetzt

    const row = await tx.postalSettings.update({ where: { orgId }, data: next, select: SELECT });
    if (changed.length > 0) {
      await logActivity(tx, {
        orgId,
        entityType: "POSTAL",
        entityId: row.id,
        type: "POSTAL_SETTINGS_CHANGED",
        actor: ctx.actor,
        data: { changed, enabled: next.enabled, mode: next.mode, autoDunningPost: next.autoDunningPost },
      });
    }
    return row;
  });
  return toView(saved);
}
