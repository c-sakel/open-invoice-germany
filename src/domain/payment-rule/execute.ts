/** Ausfuehrung faelliger Regel-Laeufe (Ausfuehrer folgt; bis dahin ohne Wirkung). */
export interface ProcessOptions {
  now?: Date;
  orgId?: string;
  limit?: number;
}

export interface ProcessResult {
  claimed: number;
  done: number;
  failed: number;
  skipped: number;
  deferred: number;
  retry: number;
}

export async function processPaymentRuleRuns(opts: ProcessOptions = {}): Promise<ProcessResult> {
  void opts;
  return { claimed: 0, done: 0, failed: 0, skipped: 0, deferred: 0, retry: 0 };
}
