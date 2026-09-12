import { describe, it, expect } from "vitest";
import { jpegComponents } from "@/lib/images/jpeg-info";
import { testJpegBuffer } from "../helpers/pdf-theme";

describe("jpegComponents", () => {
  it("liefert 3 fuer ein RGB/YCbCr-JPEG", () => {
    expect(jpegComponents(testJpegBuffer(3))).toBe(3);
  });

  it("liefert 4 fuer ein CMYK/YCCK-JPEG", () => {
    expect(jpegComponents(testJpegBuffer(4))).toBe(4);
  });

  it("liefert 1 fuer ein Graustufen-JPEG", () => {
    expect(jpegComponents(testJpegBuffer(1))).toBe(1);
  });

  it("ueberspringt APPn-Segmente (z. B. JFIF/EXIF) vor dem SOF-Marker", () => {
    const jfifApp0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const withApp0 = Buffer.concat([Buffer.from([0xff, 0xd8]), jfifApp0, testJpegBuffer(3).subarray(2)]);
    expect(jpegComponents(withApp0)).toBe(3);
  });

  it("liefert null bei fehlendem SOI-Header (kein JPEG)", () => {
    expect(jpegComponents(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("liefert null bei einer defekten/abgeschnittenen Datei", () => {
    expect(jpegComponents(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(jpegComponents(testJpegBuffer(3).subarray(0, 6))).toBeNull();
  });

  it("liefert null, wenn EOI vor einem SOF-Marker kommt", () => {
    expect(jpegComponents(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
