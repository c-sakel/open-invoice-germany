/** Server: GiroCode-Payloads als Bild (Data-URL). Die Payload enthält die volle IBAN und verlässt den Server nur als Bild. */
import QRCode from "qrcode";

export async function girocodeImages(girocodes: readonly { payload: string }[]): Promise<string[]> {
  return Promise.all(girocodes.map((g) => QRCode.toDataURL(g.payload, { errorCorrectionLevel: "M", margin: 1, width: 220 })));
}
