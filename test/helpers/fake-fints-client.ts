/**
 * Bankprotokoll-Attrappe fuer Domaintests (kein Netz, keine Bibliothek). Die Antworten werden je Sitzung der Reihe nach
 * abgearbeitet; `opens` haelt die Zugangsdaten fest, mit denen geoeffnet wurde (nur fuer Pruefungen in Tests).
 */
import {
  FintsError,
  type FintsAccess,
  type FintsCamtResult,
  type FintsClient,
  type FintsSession,
  type FintsStep,
  type FintsSyncResult,
} from "@/lib/fints/client";

export type FakeSyncAnswer = FintsStep<FintsSyncResult> | FintsError;
export type FakeContinueAnswer = FintsStep<FintsSyncResult | FintsCamtResult> | FintsError;

export function syncResult(over: Partial<FintsSyncResult> = {}): FintsSyncResult {
  return {
    tanMethods: [],
    accounts: [
      { iban: "DE89370400440532013000", accountNumber: "0532013000", subAccount: null, currency: "EUR", productName: "Girokonto", camtSupported: true },
      { iban: "DE02120300000000202051", accountNumber: "202051", subAccount: null, currency: "EUR", productName: "Tagesgeld", camtSupported: true },
    ],
    camtFormats: ["urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"],
    maxHistoryDays: 90,
    ...over,
  };
}

export const done = (value: FintsSyncResult, scaUsed = false): FintsStep<FintsSyncResult> => ({ kind: "done", value, scaUsed, bankCodes: ["0020"] });

export function decoupledChallenge(over: Partial<{ maxPolls: number; waitFirstMs: number; waitNextMs: number }> = {}): FintsStep<never> {
  return { kind: "sca", challenge: { decoupled: true, text: "Bitte in der App freigeben", image: null, waitFirstMs: 0, waitNextMs: 0, maxPolls: 5, ...over } };
}

export class FakeFintsSession implements FintsSession {
  closed = 0;
  syncCalls = 0;
  continueCalls = 0;
  tans: (string | undefined)[] = [];
  constructor(
    private readonly syncAnswers: FakeSyncAnswer[],
    private readonly continueAnswers: FakeContinueAnswer[],
    private readonly info: string | null,
  ) {}

  /** Haengt eine weitere Antwort fuer continueSca an (Tests, die erst nach dem Oeffnen entscheiden). */
  continueAnswersPush(a: FakeContinueAnswer): void {
    this.continueAnswers.push(a);
  }

  async synchronize(): Promise<FintsStep<FintsSyncResult>> {
    this.syncCalls += 1;
    const a = this.syncAnswers.shift();
    if (!a) throw new FintsError("PROTOCOL_ERROR");
    if (a instanceof FintsError) throw a;
    return a;
  }

  async fetchCamt(): Promise<FintsStep<FintsCamtResult>> {
    throw new FintsError("PROTOCOL_ERROR");
  }

  async continueSca(tan?: string): Promise<FintsStep<FintsSyncResult | FintsCamtResult>> {
    this.continueCalls += 1;
    this.tans.push(tan);
    const a = this.continueAnswers.shift();
    if (!a) throw new FintsError("PROTOCOL_ERROR");
    if (a instanceof FintsError) throw a;
    return a;
  }

  bankingInfo(): string | null {
    return this.info;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

export class FakeFintsClient implements FintsClient {
  opens: FintsAccess[] = [];
  sessions: FakeFintsSession[] = [];
  syncAnswers: FakeSyncAnswer[] = [];
  continueAnswers: FakeContinueAnswer[] = [];
  /** Wird als BPD/UPD-Zwischenspeicher der Sitzung gemeldet (Test: Verschluesselung). */
  info: string | null = '{"bpd":{"version":1},"upd":{"bankAccounts":[{"holder1":"Erika Mustermann","iban":"DE89370400440532013000"}]},"systemId":"S4711"}';

  open(access: FintsAccess): FintsSession {
    this.opens.push(access);
    const s = new FakeFintsSession(this.syncAnswers, this.continueAnswers, this.info);
    this.sessions.push(s);
    return s;
  }
}
