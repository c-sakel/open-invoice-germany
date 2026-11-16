// Ladeprobe fuer das Image (als Nutzer 1000 im Arbeitsverzeichnis /app): Postfach-Bibliothek und Mail-Worker.
// Beendet sich mit Exit 1, wenn imapflow nicht ladbar ist oder der Worker eine kleine Testmail nicht zerlegt.
import { Worker } from "node:worker_threads";
import path from "node:path";

const { ImapFlow } = await import("imapflow");
if (typeof ImapFlow !== "function") {
  console.error("imapflow: Klasse fehlt");
  process.exit(1);
}

const mail = Buffer.from(
  [
    "From: Lieferant <rechnung@lieferant.example.org>",
    "Subject: Probe",
    "Message-ID: <probe@lieferant.example.org>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Text",
    "--b",
    'Content-Type: application/pdf; name="r.pdf"',
    'Content-Disposition: attachment; filename="r.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 probe").toString("base64"),
    "--b--",
    "",
  ].join("\r\n"),
);

const worker = new Worker(path.resolve(process.cwd(), "src", "workers", "mail-worker.mjs"), {
  workerData: {
    job: "parse-mail",
    input: new Uint8Array(mail),
    params: { maxAttachments: 10, maxAttachmentBytes: 15 * 1048576, maxMailBytes: 25 * 1048576, maxParts: 100, maxNesting: 5, maxHeaderBytes: 65536, maxSubject: 200 },
  },
  env: {},
  execArgv: [],
});
const timer = setTimeout(() => {
  console.error("mail-worker: Zeitueberschreitung");
  process.exit(1);
}, 15000);
worker.on("message", (m) => {
  clearTimeout(timer);
  const ok = m?.ok === true && m.value?.senderDomain === "lieferant.example.org" && m.value?.attachments?.length === 1;
  console.log(ok ? "mail-worker: ok" : "mail-worker: unerwartete Antwort");
  process.exit(ok ? 0 : 1);
});
worker.on("error", (e) => {
  console.error("mail-worker:", e?.code ?? e?.name);
  process.exit(1);
});
