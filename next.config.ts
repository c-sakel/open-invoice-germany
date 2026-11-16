import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Nur im Container-Build (Dockerfile setzt NEXT_OUTPUT_STANDALONE=1): .next/standalone
  // enthaelt den Server und die per Tracing ermittelten Laufzeit-Abhaengigkeiten statt
  // des kompletten node_modules. Der native Betrieb (`npm run build && npm start`)
  // bleibt unveraendert — `next start` warnt sonst bei output: "standalone".
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  // next/image wird nicht genutzt: keine Bildoptimierung, das Image braucht kein sharp/libvips.
  images: { unoptimized: true },
  // imapflow (Postfach-Abruf) wird nicht gebuendelt: es laedt Teile dynamisch nach und bringt eigene Abhaengigkeiten mit.
  // pdfkit lädt .afm-Schriftdaten zur Laufzeit -> nicht ins Server-Bundle ziehen.
  serverExternalPackages: ["pdfkit", "imapflow"],
  // Dateien, die zur Laufzeit relativ zu process.cwd() gelesen werden (Worker-Skript fuer fremde PDF-Anlagen,
  // Hinweise/Lizenztexte der Pruefartefakte): das Tracing erkennt sie nicht, auch nicht deren relative Importe.
  // Das Worker-Skript fuer fremde Mails importiert die MIME-Bibliothek selbst (kein Tracing ueber new Worker).
  outputFileTracingIncludes: {
    "/*": ["./src/workers/**/*", "./assets/einvoice-validation/**/*", "./node_modules/postal-mime/**/*"],
  },
  // Eindeutige Workspace-Wurzel (verhindert Fehl-Inferenz bei mehreren Lockfiles).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
