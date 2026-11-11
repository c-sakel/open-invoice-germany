import Link from "next/link";
import { buildDocumentChain, type ChainNode } from "@/domain/document/chain";
import { StatusBadge } from "@/components/StatusBadge";

/** Anzeigename eines Knotens: Belegnummer, sonst nie die ID. */
function nodeName(node: ChainNode): string {
  if (node.number) return node.number;
  if (node.status === "UNBEKANNT") return "Beleg nicht verfügbar";
  return node.type === "RECURRING" ? "Abo" : "Entwurf";
}

/** Status je Knoten: Mahnungen/Zahlungen tragen Klartext statt eines Status-Enums. */
function NodeStatus({ node }: { node: ChainNode }) {
  if (node.type === "DUNNING") {
    const level = /^MAHNSTUFE_(\d+)$/.exec(node.status)?.[1];
    return <span className="text-xs text-ink-muted">{level ? `${level}. Stufe` : "Mahnung"}</span>;
  }
  if (node.type === "PAYMENT") return <span className="text-xs text-ink-muted">{node.status}</span>;
  if (node.status === "UNBEKANNT") return null;
  return <StatusBadge status={node.status} />;
}

function NodeRow({ node, currentId, depth }: { node: ChainNode; currentId: string; depth: number }) {
  const isCurrent = node.id === currentId;
  return (
    <li>
      <div
        className={`flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
          isCurrent ? "bg-pen-wash font-semibold text-pen" : "text-ink-soft"
        }`}
        style={{ marginLeft: depth * 16 }}
      >
        <span className="text-ink-muted">{node.label}</span>
        {node.href && !isCurrent ? (
          <Link href={node.href} className="text-pen hover:underline">
            {nodeName(node)}
          </Link>
        ) : (
          <span>{nodeName(node)}</span>
        )}
        <NodeStatus node={node} />
        {node.relation && <span className="text-xs text-ink-muted">({node.relation})</span>}
        {isCurrent && <span className="text-xs text-pen">← aktuell</span>}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <NodeRow key={`${c.type}:${c.id}`} node={c} currentId={currentId} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Zeigt die vollstaendige Dokumentkette (Angebot -> AB -> Lieferschein(e) -> Rechnung ->
 *  Zahlungen/Mahnungen) als eingerueckte Liste. Gibt bei Fehlern (z. B. Beleg nicht
 *  gefunden) still nichts aus, statt die Seite abzureissen. */
export async function DocumentChain({ orgId, type, id }: { orgId: string; type: "QUOTE" | "INVOICE" | "DELIVERY_NOTE"; id: string }) {
  let chain: Awaited<ReturnType<typeof buildDocumentChain>> | null = null;
  try {
    chain = await buildDocumentChain(orgId, type, id);
  } catch {
    return null;
  }
  if (!chain) return null;

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] bg-sheet p-4 text-sm shadow-[var(--shadow-card)]">
      <h2 className="font-semibold text-ink">Dokumentenkette</h2>
      <ul>
        <NodeRow node={chain.root} currentId={chain.currentId} depth={0} />
      </ul>
    </div>
  );
}
