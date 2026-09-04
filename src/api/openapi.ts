/**
 * OpenAPI-3.1-Registry + Generator (Phase 10, Task 4, task-4-facts.md):
 *
 * - `discoverRouteSpecs()` scannt das Dateisystem (src/app/api/v1/**\/route.ts) und
 *   importiert jede Route-Datei, um ihren `spec`-Export (src/api/spec.ts) einzusammeln —
 *   KEINE handgepflegte Liste. Jede Route OHNE `spec`-Export laesst die Funktion werfen
 *   (Round-Trip-Pflicht aus task-4-facts.md/test/unit/openapi.test.ts).
 * - `buildOpenApiDocument()` baut daraus mit `@asteasolutions/zod-to-openapi` ein
 *   OpenAPI-3.1-Dokument. Deterministisch: `serializeDocument()` sortiert JEDEN
 *   Objekt-Schluessel rekursiv, bevor JSON geschrieben wird — unabhaengig von der
 *   internen Einfuegereihenfolge der Bibliothek oder der Dateisystem-Scan-Reihenfolge.
 *
 * Response-Schemas je Ressource (task-4-facts.md, zweiter Spiegelstrich: "Task 4 muss
 * je Ressource Response-Zod-Schemas aus den Serializern ableiten"): jedes Serialisierer-
 * Modul (src/api/serializers/*.ts) exportiert seit diesem Task zusaetzlich zur
 * `serialize*`-Funktion ein passendes Zod-Schema (`contactSchema`, `invoiceSchema`, ...).
 * `RESOURCE_SCHEMAS` unten ist eine kleine, bewusst HANDGEPFLEGTE Zuordnung
 * Ressourcenname -> Schema (Zod-Schemas lassen sich nicht aus den `serialize*`-
 * Funktionen selbst per Dateisystem-Scan ableiten, nur die ROUTEN-Registry ist ein
 * echter fs-Scan). Fuer Task 5 (Webhooks): ein Eintrag `Webhook: webhookSchema` +
 * der Import der neuen `src/api/serializers/webhook.ts#webhookSchema` genuegt — die
 * Routen-Discovery selbst braucht keine Aenderung, `/api/v1/Webhook/route.ts` wird vom
 * fs-Scan automatisch gefunden, sobald die Datei existiert.
 *
 * Diese Ueberschreibung gilt NUR fuer die "Basis-CRUD"-Pfade (`/api/v1/<Resource>` bzw.
 * `/api/v1/<Resource>/{id}`, siehe `baseResourceName()`) — Aktions-/Datei-Endpunkte
 * (Task 3, z. B. `/Invoice/{id}/finalize`) behalten ihre in der Route deklarierte
 * `response`-Form (ueberwiegend `z.unknown()`-Nutzlast, siehe Task-2/3-Report
 * "Deviations"; ausserhalb des Scopes dieses Tasks, ~20 Routen retroaktiv mit exakten
 * Ad-hoc-Antwortschemas zu versehen).
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import type { SchemaObject } from "openapi3-ts/oas31";
import type { RouteSpec } from "./spec";
import { contactSchema, contactAddressSchema, contactPersonSchema } from "./serializers/contact";
import { productSchema } from "./serializers/product";
import { quoteSchema, orderConfirmationSchema } from "./serializers/document";
import { deliveryNoteSchema } from "./serializers/delivery-note";
import { invoiceSchema } from "./serializers/invoice";
import { paymentSchema } from "./serializers/payment";
import { dunningSchema } from "./serializers/dunning";
import { attachmentSchema } from "./serializers/attachment";
import { emailLogSchema } from "./serializers/email-log";
import { paymentMethodSchema } from "./serializers/payment-method";
import { textTemplateSchema } from "./serializers/text-template";
import { emailTemplateSchema } from "./serializers/email-template";
import { apiKeySchema } from "./serializers/api-key";
import { recurringSchema } from "./serializers/recurring";

extendZodWithOpenApi(z);

const V1_ROOT = path.resolve(process.cwd(), "src/app/api/v1");

export interface DiscoveredRoute {
  /** Pfad relativ zu src/app/api/v1, z. B. "Invoice/[id]/pdf/route.ts" — nur fuer Diagnose. */
  relPath: string;
  spec: Record<string, RouteSpec>;
}

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findRouteFiles(full));
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scannt src/app/api/v1/**\/route.ts, importiert jede Datei und sammelt ihren
 * `spec`-Export. Wirft, wenn eine Route-Datei KEINEN `spec`-Export hat — das ist die
 * eine Haelfte des Round-Trip-Tests (jede App-Route hat einen Spec-Eintrag).
 */
export async function discoverRouteSpecs(): Promise<DiscoveredRoute[]> {
  const files = findRouteFiles(V1_ROOT);
  const routes: DiscoveredRoute[] = [];
  for (const file of files) {
    const mod = (await import(file)) as { spec?: Record<string, RouteSpec> };
    const relPath = path.relative(V1_ROOT, file);
    if (!mod.spec) {
      throw new Error(`Route ohne "spec"-Export (task-4-facts.md Round-Trip-Pflicht): src/app/api/v1/${relPath}`);
    }
    routes.push({ relPath, spec: mod.spec });
  }
  return routes;
}

/** `objectName` -> Response-Zod-Schema, siehe Modulkommentar oben. */
export const RESOURCE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  Contact: contactSchema,
  ContactAddress: contactAddressSchema,
  ContactPerson: contactPersonSchema,
  Product: productSchema,
  Quote: quoteSchema,
  OrderConfirmation: orderConfirmationSchema,
  DeliveryNote: deliveryNoteSchema,
  Invoice: invoiceSchema,
  Payment: paymentSchema,
  Dunning: dunningSchema,
  Attachment: attachmentSchema,
  EmailLog: emailLogSchema,
  PaymentMethod: paymentMethodSchema,
  TextTemplate: textTemplateSchema,
  EmailTemplate: emailTemplateSchema,
  Settings: z.object({
    objectName: z.literal("Settings"),
    documents: z.record(z.string(), z.unknown()),
    branding: z.record(z.string(), z.unknown()),
    print: z.record(z.string(), z.unknown()),
  }),
  ApiKey: apiKeySchema,
  Recurring: recurringSchema,
};

/** `/api/v1/Invoice` oder `/api/v1/Invoice/{id}` -> "Invoice"; alles Tiefere (Aktionen,
 *  verschachtelte Unterpfade) liefert `undefined` (keine Ueberschreibung). */
export function baseResourceName(routePath: string): string | undefined {
  const m = /^\/api\/v1\/([A-Za-z]+)(?:\/\{id\})?$/.exec(routePath);
  return m?.[1];
}

/** Pfadparameter aus `{name}`-Platzhaltern im Pfad ableiten (keine Route deklariert
 *  `request.params` explizit, siehe task-2/3-report — alle nutzen `ctx.params` roh). */
function paramsSchemaFromPath(routePath: string): z.ZodObject | undefined {
  const names = [...routePath.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  if (names.length === 0) return undefined;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const n of names) shape[n] = z.string();
  return z.object(shape);
}

/** Generischer Beispielwert-Generator (zod v4 `.def`-Introspektion) — fuer Endpunkte
 *  ohne handgepflegtes Beispiel (Aktions-/Datei-Routen). */
export function sampleValue(schema: z.ZodTypeAny, hint?: string): unknown {
  const def = (schema as unknown as { def: Record<string, unknown> }).def;
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodTypeAny>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) out[key] = sampleValue(value, key);
      return out;
    }
    case "array":
      return [sampleValue(def.element as z.ZodTypeAny, hint)];
    case "record":
      return {};
    case "string":
      if (!hint) return "string";
      if (/(At|Date|Start|End|Until)$/.test(hint)) return "2076-01-15T09:00:00.000Z";
      if (hint === "id" || /Id$/.test(hint)) return "cljs0000000000000000000";
      if (/email/i.test(hint)) return "kunde@example.de";
      return hint;
    case "number":
      return /cents$/i.test(hint ?? "") ? 1000 : /permille$/i.test(hint ?? "") ? 0 : 1;
    case "boolean":
      return false;
    case "literal":
      return (def.values as unknown[])[0];
    case "enum":
      return Object.values(def.entries as Record<string, string>)[0];
    case "nullable":
    case "optional":
    case "default":
      return sampleValue(def.innerType as z.ZodTypeAny, hint);
    default:
      return null;
  }
}

/**
 * Rohes OpenAPI-SchemaObject fuer den Fehler-Umschlag (statt eines Zod-Schemas):
 * `@asteasolutions/zod-to-openapi@9.1.0#registry.register()` ruft intern
 * `zodSchema.openapi(refId, ...)` auf, was bei zod@4.4.3s "classic"-Klassen (ZodObject
 * etc. teilen sich NICHT das Prototyp-Objekt von `z.ZodType`, obwohl `instanceof`
 * dank eines eigenen `Symbol.hasInstance` trotzdem `true` liefert — verifiziert per
 * Spike) mit `TypeError: zodSchema.openapi is not a function` bricht. Betrifft NUR
 * `.register()`/`.registerParameter()` (die `.openapi()` selbst aufrufen), NICHT das
 * direkte Verwenden von Zod-Schemas als `content.schema` in `registerPath()` (die
 * Bibliothek liest deren Form ueber die interne Zod-Introspektion, ruft dafuer nie
 * `.openapi()` auf der Instanz auf) — deshalb bleiben alle Ressourcen-/Request-Schemas
 * unten normale Zod-Schemas, nur der wiederkehrende Fehler-Umschlag wird als rohes
 * SchemaObject definiert.
 */
const API_ERROR_SCHEMA_OBJECT: SchemaObject = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

const ERROR_INFO: Record<number, { code: string; message: string }> = {
  400: { code: "VALIDATION", message: "Validierung fehlgeschlagen." },
  401: { code: "UNAUTHORIZED", message: "Kein gueltiger API-Schluessel im Authorization-Header." },
  403: { code: "FORBIDDEN", message: 'API-Schluessel hat nicht den erforderlichen Scope "write".' },
  404: { code: "NOT_FOUND", message: "Nicht gefunden." },
  409: { code: "CONFLICT", message: "Zustandskonflikt (z. B. bereits festgeschrieben)." },
  429: { code: "RATE_LIMITED", message: "Rate-Limit ueberschritten (600/Minute je Schluessel)." },
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Validierungsfehler (Zod) — `error.details.issues`.",
  401: "Kein gueltiger Bearer-Token.",
  403: "Token hat nicht den erforderlichen Scope.",
  404: "Ressource nicht gefunden oder gehoert nicht zur Organisation des Schluessels.",
  409: "Zustandskonflikt (GoBD-Regel, Idempotenz-Konflikt oder EN-16931-Validierung).",
  429: "Rate-Limit ueberschritten — `Retry-After`-Header beachten.",
};

const BINARY_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  xrechnung: "application/xml",
  zugferd: "application/xml",
};

function binaryKindForPath(routePath: string): string | undefined {
  const tail = routePath.split("/").pop() ?? "";
  return tail in BINARY_CONTENT_TYPE ? tail : undefined;
}

function tagForPath(routePath: string): string {
  const seg = routePath.split("/")[3];
  return seg ?? "Sonstiges";
}

/** Rekursiv jeden Objekt-Schluessel alphabetisch sortieren — macht die JSON-Ausgabe
 *  unabhaengig von jeder internen Einfuegereihenfolge (Determinismus-Pflicht,
 *  task-4-facts.md "openapi/openapi.json deterministisch (sortierte Keys)"). */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/** JSON-Serialisierung mit sortierten Schluesseln + abschliessendem Zeilenumbruch —
 *  identisch fuer Generator UND `openapi/openapi.json` (fuer den `api:check`-Diff). */
export function serializeDocument(doc: unknown): string {
  return JSON.stringify(sortKeysDeep(doc), null, 2) + "\n";
}

export function buildOpenApiDocument(routes: DiscoveredRoute[]): Record<string, unknown> {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: 'API-Schluessel als Bearer-Token, Format "oig_<32 Byte base64url>" (Einstellungen -> API).',
  });

  // Alle Specs einer Datei einsammeln, nach Pfad+Methode sortieren fuer einen
  // deterministischen Registrierungslauf (die endgueltige JSON-Ausgabe wird zusaetzlich
  // per sortKeysDeep() sortiert — diese Sortierung hier dient nur der Nachvollziehbarkeit).
  const flatSpecs = routes
    .flatMap((r) => Object.entries(r.spec).map(([key, spec]) => ({ key, spec })))
    .sort((a, b) => (a.spec.path === b.spec.path ? a.spec.method.localeCompare(b.spec.method) : a.spec.path.localeCompare(b.spec.path)));

  for (const { key, spec } of flatSpecs) {
    const resource = baseResourceName(spec.path);
    const resourceSchema = resource ? RESOURCE_SCHEMAS[resource] : undefined;
    const binaryKind = binaryKindForPath(spec.path);

    let responseSchema: z.ZodTypeAny | undefined;
    let example: unknown;
    if (resourceSchema && key === "list") {
      responseSchema = z.object({ data: z.array(resourceSchema), total: z.number().int(), limit: z.number().int(), offset: z.number().int() });
      const item = sampleValue(resourceSchema);
      example = { data: [item], total: 1, limit: 50, offset: 0 };
    } else if (resourceSchema) {
      responseSchema = z.object({ data: resourceSchema });
      example = { data: sampleValue(resourceSchema) };
    } else if (!binaryKind) {
      responseSchema = spec.response;
      example = sampleValue(spec.response);
    }

    const responses: RouteConfig["responses"] = {};
    if (binaryKind) {
      responses["200"] = {
        description: `Datei (${BINARY_CONTENT_TYPE[binaryKind]}).`,
        content: { [BINARY_CONTENT_TYPE[binaryKind]]: { schema: { type: "string", format: "binary" } } },
      };
    } else {
      const successStatus = spec.method === "POST" && key !== "list" ? (key === "create" ? "201" : "200") : "200";
      responses[successStatus] = {
        description: spec.summary,
        content: { "application/json": { schema: responseSchema, example } },
      };
    }
    for (const status of spec.errors) {
      const info = ERROR_INFO[status];
      responses[String(status)] = {
        description: ERROR_DESCRIPTIONS[status] ?? "Fehler.",
        content: {
          "application/json": {
            schema: API_ERROR_SCHEMA_OBJECT,
            example: info ? { error: { code: info.code, message: info.message } } : undefined,
          },
        },
      };
    }

    // Keine Route deklariert `request.params` explizit (siehe Kommentar bei
    // `paramsSchemaFromPath`) — die abgeleiteten `{name}`-Platzhalter sind immer ein
    // einfaches `z.object({...: z.string()})`, strukturell kompatibel zu `RouteParameter`
    // (ZodObject | ZodPipe); der Cast ist deshalb sicher, `RouteParameter` selbst ist
    // kein oeffentlicher Export der Bibliothek.
    const params = (spec.request?.params ?? paramsSchemaFromPath(spec.path)) as NonNullable<RouteConfig["request"]>["params"];
    const query = spec.request?.query as NonNullable<RouteConfig["request"]>["query"];
    const bodySchema = spec.request?.body;

    registry.registerPath({
      method: spec.method.toLowerCase() as "get" | "post" | "patch",
      path: spec.path,
      tags: [tagForPath(spec.path)],
      summary: spec.summary,
      description: `Scope: \`${spec.scope}\`.`,
      security: [{ bearerAuth: [] }],
      request: {
        ...(params ? { params } : {}),
        ...(query ? { query } : {}),
        ...(bodySchema
          ? { body: { content: { "application/json": { schema: bodySchema, example: sampleValue(bodySchema) } } } }
          : {}),
      },
      responses,
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions, { sortComponents: "alphabetically" });
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "OpenInvoice Germany API",
      version: "1.0.0",
      description:
        "Oeffentliche, versionierte REST-API (`/api/v1`) fuer OpenInvoice Germany — dieselben Domain-Funktionen wie UI und MCP, GoBD-konform (festgeschriebene Belege nur ueber Storno/Gutschrift/Korrektur). Authentifizierung ausschliesslich per Bearer-API-Schluessel (Einstellungen -> API). Antwortformat: `{data}` bzw. `{data,total,limit,offset}`; Fehler: `{error:{code,message,details?}}`.",
    },
    // Kein Server-Praefix: jeder `spec.path` ist bereits absolut (z. B. "/api/v1/Invoice") —
    // ein Server-Praefix wuerde ihn verdoppeln.
    servers: [{ url: "/" }],
  }) as unknown as Record<string, unknown>;
}
