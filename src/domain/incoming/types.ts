export type { ParsedIncomingInvoice, IncomingHintCode } from "@/schemas/incoming";
export type { Container, XmlClass } from "./detect";

export type IncomingKind = "EINVOICE" | "HYBRID" | "OTHER";
export type IncomingChannel = "UPLOAD" | "API" | "MCP";
