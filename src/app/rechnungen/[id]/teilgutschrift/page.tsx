import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { loadDocumentSettings } from "@/domain/document/settings";
import { creditCapCents, openAmountCents } from "@/domain/invoice/amounts";
import { PartialCreditForm } from "@/components/PartialCreditForm";

export const dynamic = "force-dynamic";

export default async function TeilgutschriftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getActiveOrg();
  const inv = await prisma.invoice.findFirst({
    where: { id, orgId: org.id },
    include: { lines: { orderBy: { position: "asc" } } },
  });
  if (!inv) notFound();
  const { taxRates } = await loadDocumentSettings(org.id);

  if (inv.status === "CANCELLED") {
    return (
      <div className="rounded-lg border border-seal/30 bg-seal/10 p-6 text-sm text-seal">
        Die Rechnung {inv.number} ist storniert — eine Teilgutschrift ist nicht mehr möglich.
      </div>
    );
  }

  if (inv.status === "DRAFT") {
    return (
      <div className="rounded-lg border border-seal/30 bg-seal/10 p-6 text-sm text-seal">
        Eine Teilgutschrift ist erst nach dem Festschreiben möglich.
      </div>
    );
  }

  const credits = await prisma.invoice.aggregate({
    where: { correctsInvoiceId: inv.id, type: "CREDIT_NOTE", status: { not: "DRAFT" } },
    _sum: { grossTotalCents: true },
  });
  const remainingCents = Math.max(0, creditCapCents(inv) - Math.abs(credits._sum.grossTotalCents ?? 0));

  // Teilgutschrift nur ueber ITEM-Positionen — HEADING/TEXT/SUBTOTAL tragen keinen Betrag
  // und werden hier nicht angeboten (§8, K1).
  const initialLines = inv.lines
    .filter((l) => l.lineType === "ITEM")
    .map((l) => ({
      description: l.description,
      quantity: String(l.quantityMilli / 1000),
      unit: l.unit,
      price: (Math.abs(l.unitNetPriceCents) / 100).toFixed(2),
      taxRate: l.taxRate,
    }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/rechnungen/${id}`} className="text-sm text-ink-muted hover:text-ink">
          ← Rechnung {inv.number}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Teilgutschrift</h1>
      </div>
      <PartialCreditForm invoiceId={id} remainingCents={remainingCents} openCents={openAmountCents(inv)} currency={inv.currency} initialLines={initialLines} taxRates={taxRates} />
    </div>
  );
}
