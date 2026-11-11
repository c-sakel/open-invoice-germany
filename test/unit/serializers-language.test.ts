import { describe, it, expect } from "vitest";
import type { Quote, DeliveryNote, RecurringInvoice, EmailTemplate, TextTemplate } from "@/generated/prisma/client";
import { serializeQuote, quoteSchema } from "@/api/serializers/document";
import { serializeDeliveryNote, deliveryNoteSchema } from "@/api/serializers/delivery-note";
import { serializeRecurring, recurringSchema } from "@/api/serializers/recurring";
import { serializeEmailTemplate, emailTemplateSchema } from "@/api/serializers/email-template";
import { serializeTextTemplate, textTemplateSchema } from "@/api/serializers/text-template";

/** Phase 16b: die Belegsprache (Snapshot) ist ueber die REST-Antworten lesbar. */
describe("Serializer liefern language", () => {
  it("Quote, DeliveryNote, Recurring, EmailTemplate, TextTemplate", () => {
    expect(serializeQuote({ language: "en" } as unknown as Quote, "Quote", new Set()).language).toBe("en");
    expect(serializeDeliveryNote({ language: "en" } as unknown as DeliveryNote, new Set()).language).toBe("en");
    expect(serializeRecurring({ language: "en" } as unknown as RecurringInvoice).language).toBe("en");
    expect(serializeEmailTemplate({ language: "en" } as unknown as EmailTemplate).language).toBe("en");
    expect(serializeTextTemplate({ language: "en" } as unknown as TextTemplate).language).toBe("en");
  });

  it("Antwortschemas kennen das Feld", () => {
    for (const schema of [quoteSchema, deliveryNoteSchema, recurringSchema, emailTemplateSchema, textTemplateSchema]) {
      expect(Object.keys(schema.shape)).toContain("language");
    }
  });
});
