import Link from "next/link";
import { buttonClass } from "./Button";

interface EmptyStateProps {
  text: string;
  action?: { label: string; href: string };
}

/** Leerer Zustand einer Liste: Satz plus optional eine Handlung als Link. */
export function EmptyState({ text, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] bg-well px-4 py-10 text-center">
      <p className="text-sm text-ink-soft">{text}</p>
      {action && (
        <Link href={action.href} className={buttonClass("secondary", "sm")}>
          {action.label}
        </Link>
      )}
    </div>
  );
}
