/** Postfach-Attrappe fuer Domaintests: verhaelt sich wie der Adapter (Fehler schliesst die Sitzung). Nie ein echtes Netz. */
import { MailboxError, type MailboxAccount, type MailboxClient, type MailboxErrorCode, type MailboxSession } from "@/lib/mailbox/client";

export interface FakeMail {
  uid: string;
  raw: Uint8Array;
  /** Vom Server gemeldete Groesse (Standard: Laenge von raw). */
  size?: number;
  seen?: boolean;
  internalDate?: Date;
}

export interface FakeMailboxOptions {
  mails: FakeMail[];
  uidValidity?: string;
  openError?: MailboxErrorCode;
  markSeenThrows?: boolean;
  /** fetchRaw wartet so lange (ms) und gibt erst dann zurueck; close() bricht ab. */
  fetchDelayMs?: number;
  /** fetchRaw scheitert fuer diese UIDs jedes Mal mit PROTOCOL_ERROR (Sitzung wird geschlossen). */
  failFetchUids?: string[];
}

export class FakeMailboxClient implements MailboxClient {
  opens = 0;
  accounts: MailboxAccount[] = [];
  searchedSince: (Date | null)[] = [];
  markedSeen: string[] = [];
  fetched: string[] = [];
  closed = 0;
  constructor(public opts: FakeMailboxOptions) {}

  async open(account: MailboxAccount): Promise<MailboxSession> {
    this.opens += 1;
    this.accounts.push(account);
    if (this.opts.openError) throw new MailboxError(this.opts.openError);
    let dead = false;
    let abort: (() => void) | null = null;
    const alive = () => {
      if (dead) throw new MailboxError("PROTOCOL_ERROR");
    };
    const kill = (code: MailboxErrorCode): never => {
      dead = true;
      throw new MailboxError(code);
    };
    return {
      uidValidity: this.opts.uidValidity ?? "1700000000",
      searchUnseen: async (since) => {
        alive();
        this.searchedSince.push(since);
        return this.opts.mails.filter((m) => !m.seen).map((m) => m.uid).sort((a, b) => Number(a) - Number(b));
      },
      meta: async (uid) => {
        alive();
        const m = this.opts.mails.find((x) => x.uid === uid);
        if (!m) return null;
        const from = /^From:[^\r\n]*@([A-Za-z0-9.-]+)/im.exec(Buffer.from(m.raw.subarray(0, 4096)).toString("latin1"));
        return { size: m.size ?? m.raw.byteLength, internalDate: m.internalDate ?? new Date("2026-11-10T10:00:00.000Z"), fromDomain: from?.[1]?.toLowerCase() ?? null };
      },
      fetchRaw: async (uid, maxBytes) => {
        alive();
        this.fetched.push(uid);
        const m = this.opts.mails.find((x) => x.uid === uid);
        if (!m || this.opts.failFetchUids?.includes(uid)) return kill("PROTOCOL_ERROR");
        if (this.opts.fetchDelayMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, this.opts.fetchDelayMs);
            abort = () => {
              clearTimeout(t);
              dead = true;
              reject(new MailboxError("TIMEOUT"));
            };
          });
        }
        if (m.raw.byteLength > maxBytes) return kill("TOO_LARGE");
        return m.raw;
      },
      markSeen: async (uid) => {
        alive();
        if (this.opts.markSeenThrows) return kill("PROTOCOL_ERROR");
        this.markedSeen.push(uid);
        const m = this.opts.mails.find((x) => x.uid === uid);
        if (m) m.seen = true;
      },
      countUnseen: async () => {
        alive();
        return this.opts.mails.filter((m) => !m.seen).length;
      },
      close: async () => {
        this.closed += 1;
        const a = abort;
        abort = null;
        dead = true;
        a?.();
      },
    };
  }
}
