import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Nur im Container-Build (Dockerfile setzt NEXT_OUTPUT_STANDALONE=1): .next/standalone
  // enthaelt den Server und die per Tracing ermittelten Laufzeit-Abhaengigkeiten statt
  // des kompletten node_modules. Der native Betrieb (`npm run build && npm start`)
  // bleibt unveraendert — `next start` warnt sonst bei output: "standalone".
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  // next/image wird nicht genutzt: keine Bildoptimierung, das Image braucht kein sharp/libvips.
  images: { unoptimized: true },
  // pdfkit lädt .afm-Schriftdaten zur Laufzeit -> nicht ins Server-Bundle ziehen.
  serverExternalPackages: ["pdfkit"],
  // Eindeutige Workspace-Wurzel (verhindert Fehl-Inferenz bei mehreren Lockfiles).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
