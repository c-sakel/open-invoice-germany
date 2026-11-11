import Link from "next/link";

export function NeedOrgNotice() {
  return (
    <div className="rounded-lg border border-seal/30 bg-seal/10 p-6 text-sm text-seal">
      Bitte zuerst dein{" "}
      <Link href="/einstellungen" className="font-medium underline">
        Unternehmen einrichten
      </Link>
      , bevor du Kunden oder Rechnungen anlegst.
    </div>
  );
}
