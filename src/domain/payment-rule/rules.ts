/**
 * Verwaltung der Regeln nach Zahlungseingang: anlegen, aendern, archivieren, auflisten.
 * Anlegen/Aendern laufen unter der Organisationssperre (Limit je Organisation, Referenzpruefung).
 */
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { PaymentRuleError } from "./errors";
import {
  paymentRuleActionSchema,
  paymentRuleInputSchema,
  paymentRuleUpdateSchema,
  PAYMENT_SOURCES,
  type PaymentRuleAction,
  type PaymentRuleInput,
} from "@/schemas/payment-rule";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";

export const MAX_RULES_PER_ORG = 20;
/** Vorlagentyp der Zahlungsbestaetigung (Mailvorlagen). */
const PAYMENT_CONFIRMATION_DOC_TYPE = "PAYMENT_CONFIRMATION";

export interface PaymentRuleView {
  id: string;
  name: string;
  active: boolean;
  trigger: "PAID_FULL" | "PAID_PARTIAL";
  sources: PaymentRuleInput["sources"];
  invoiceTagId: string | null;
  delayMinutes: number;
  actions: PaymentRuleAction[];
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Filter- oder Aktions-Tag existiert nicht mehr (Regel trifft dann nie bzw. die Aktion schlaegt fehl). */
  tagMissing: boolean;
}

const RULE_SELECT = {
  id: true,
  name: true,
  active: true,
  trigger: true,
  sourcesJson: true,
  invoiceTagId: true,
  delayMinutes: true,
  actionsJson: true,
  sortOrder: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type RuleRow = Prisma.PaymentRuleGetPayload<{ select: typeof RULE_SELECT }>;

const sourcesJsonSchema = z.array(z.enum(PAYMENT_SOURCES)).nullable();
const actionsJsonSchema = z.array(paymentRuleActionSchema);

function toView(row: RuleRow, existingTagIds: ReadonlySet<string>): PaymentRuleView {
  const actions = actionsJsonSchema.parse(JSON.parse(row.actionsJson));
  const sources = row.sourcesJson === null ? null : sourcesJsonSchema.parse(JSON.parse(row.sourcesJson));
  const tagIds = [row.invoiceTagId, ...actions.map((a) => (a.type === "ADD_TAG" ? a.tagId : null))].filter((x): x is string => x !== null);
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    trigger: row.trigger === "PAID_PARTIAL" ? "PAID_PARTIAL" : "PAID_FULL",
    sources,
    invoiceTagId: row.invoiceTagId,
    delayMinutes: row.delayMinutes,
    actions,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tagMissing: tagIds.some((t) => !existingTagIds.has(t)),
  };
}

async function existingTags(db: Prisma.TransactionClient | typeof dbInternal, orgId: string, rows: readonly RuleRow[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.invoiceTagId) ids.add(r.invoiceTagId);
    for (const a of actionsJsonSchema.parse(JSON.parse(r.actionsJson))) if (a.type === "ADD_TAG") ids.add(a.tagId);
  }
  if (ids.size === 0) return new Set();
  const found = await db.tag.findMany({ where: { orgId, id: { in: [...ids] } }, select: { id: true } });
  return new Set(found.map((t) => t.id));
}

export async function listPaymentRules(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<PaymentRuleView[]> {
  const rows = await dbInternal.paymentRule.findMany({
    where: { orgId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: RULE_SELECT,
  });
  const tags = await existingTags(dbInternal, orgId, rows);
  return rows.map((r) => toView(r, tags));
}

export async function getPaymentRule(orgId: string, id: string): Promise<PaymentRuleView> {
  const row = await dbInternal.paymentRule.findFirst({ where: { id, orgId }, select: RULE_SELECT });
  if (!row) throw new NotFoundError("Zahlungsregel nicht gefunden.");
  return toView(row, await existingTags(dbInternal, orgId, [row]));
}

/** Prueft Verweise auf Tags und Mailvorlagen der Organisation (Zahlungsregeln duerfen nie fremde Daten referenzieren). */
async function assertReferences(tx: Prisma.TransactionClient, orgId: string, input: Pick<PaymentRuleInput, "invoiceTagId" | "actions">): Promise<void> {
  const tagIds = new Set<string>();
  if (input.invoiceTagId) tagIds.add(input.invoiceTagId);
  for (const a of input.actions) if (a.type === "ADD_TAG") tagIds.add(a.tagId);
  if (tagIds.size > 0) {
    const found = await tx.tag.count({ where: { orgId, id: { in: [...tagIds] } } });
    if (found !== tagIds.size) throw new PaymentRuleError("Tag nicht gefunden.");
  }
  for (const a of input.actions) {
    if (a.type !== "SEND_PAYMENT_CONFIRMATION" || a.templateId === null) continue;
    const tpl = await tx.emailTemplate.findFirst({ where: { id: a.templateId, orgId, docType: PAYMENT_CONFIRMATION_DOC_TYPE }, select: { id: true } });
    if (!tpl) throw new PaymentRuleError("Mailvorlage nicht gefunden oder nicht vom Typ Zahlungsbestaetigung.");
  }
}

async function assertLimit(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const n = await tx.paymentRule.count({ where: { orgId, archivedAt: null } });
  if (n >= MAX_RULES_PER_ORG) throw new PaymentRuleError(`Hoechstens ${MAX_RULES_PER_ORG} Regeln je Organisation.`);
}

export async function createPaymentRule(orgId: string, raw: unknown, actor: string): Promise<PaymentRuleView> {
  const input = paymentRuleInputSchema.parse(raw);
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    await assertLimit(tx, orgId);
    await assertReferences(tx, orgId, input);
    const row = await tx.paymentRule.create({
      data: {
        orgId,
        name: input.name,
        active: input.active,
        trigger: input.trigger,
        sourcesJson: input.sources === null ? null : JSON.stringify(input.sources),
        invoiceTagId: input.invoiceTagId,
        delayMinutes: input.delayMinutes,
        actionsJson: JSON.stringify(input.actions),
        sortOrder: input.sortOrder,
      },
      select: RULE_SELECT,
    });
    await logActivity(tx, { orgId, entityType: "PAYMENT_RULE", entityId: row.id, type: "PAYMENT_RULE_SAVED", actor, data: { created: true, name: row.name } });
    return toView(row, await existingTags(tx, orgId, [row]));
  });
}

export async function updatePaymentRule(orgId: string, id: string, raw: unknown, actor: string): Promise<PaymentRuleView> {
  const patch = paymentRuleUpdateSchema.parse(raw);
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const current = await tx.paymentRule.findFirst({ where: { id, orgId }, select: RULE_SELECT });
    if (!current) throw new NotFoundError("Zahlungsregel nicht gefunden.");
    if (current.archivedAt !== null) throw new PaymentRuleError("Archivierte Regeln koennen nicht geaendert werden.");
    const cur = toView(current, new Set());
    const next: PaymentRuleInput = {
      name: patch.name ?? cur.name,
      active: patch.active ?? cur.active,
      trigger: patch.trigger ?? cur.trigger,
      sources: patch.sources !== undefined ? patch.sources : cur.sources,
      invoiceTagId: patch.invoiceTagId !== undefined ? patch.invoiceTagId : cur.invoiceTagId,
      delayMinutes: patch.delayMinutes ?? cur.delayMinutes,
      actions: patch.actions ?? cur.actions,
      sortOrder: patch.sortOrder ?? cur.sortOrder,
    };
    // Verweise nur pruefen, wenn sie geaendert werden: eine Regel mit inzwischen geloeschtem Tag bleibt sonst unbearbeitbar.
    if (patch.invoiceTagId !== undefined || patch.actions !== undefined) {
      await assertReferences(tx, orgId, {
        invoiceTagId: patch.invoiceTagId !== undefined ? next.invoiceTagId : null,
        actions: patch.actions !== undefined ? next.actions : [],
      });
    }
    const row = await tx.paymentRule.update({
      where: { id },
      data: {
        name: next.name,
        active: next.active,
        trigger: next.trigger,
        sourcesJson: next.sources === null ? null : JSON.stringify(next.sources),
        invoiceTagId: next.invoiceTagId,
        delayMinutes: next.delayMinutes,
        actionsJson: JSON.stringify(next.actions),
        sortOrder: next.sortOrder,
      },
      select: RULE_SELECT,
    });
    await logActivity(tx, { orgId, entityType: "PAYMENT_RULE", entityId: id, type: "PAYMENT_RULE_SAVED", actor, data: { created: false, changed: Object.keys(patch) } });
    return toView(row, await existingTags(tx, orgId, [row]));
  });
}

export async function archivePaymentRule(orgId: string, id: string, actor: string): Promise<PaymentRuleView> {
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const current = await tx.paymentRule.findFirst({ where: { id, orgId }, select: { id: true, archivedAt: true } });
    if (!current) throw new NotFoundError("Zahlungsregel nicht gefunden.");
    if (current.archivedAt !== null) {
      const again = await tx.paymentRule.findFirstOrThrow({ where: { id, orgId }, select: RULE_SELECT });
      return toView(again, await existingTags(tx, orgId, [again]));
    }
    const row = await tx.paymentRule.update({ where: { id }, data: { archivedAt: new Date(), active: false }, select: RULE_SELECT });
    await logActivity(tx, { orgId, entityType: "PAYMENT_RULE", entityId: id, type: "PAYMENT_RULE_ARCHIVED", actor, data: { name: row.name } });
    return toView(row, await existingTags(tx, orgId, [row]));
  });
}
