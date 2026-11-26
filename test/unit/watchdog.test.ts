import { describe, it, expect } from "vitest";
import { evaluateWatchdog, type WatchdogInput } from "@/domain/system/watchdog";

const NOW = new Date("2330-05-10T12:00:00.000Z");
const ago = (h: number, m = 0) => new Date(NOW.getTime() - (h * 60 + m) * 60_000);
const STARTED = ago(100);

function input(over: Partial<WatchdogInput>): WatchdogInput {
  return { now: NOW, startedAt: STARTED, lastOkByJob: {}, backup: { configured: false, lastOkAt: null }, disks: [], ...over };
}

describe("evaluateWatchdog", () => {
  it("Job vor 1:59 h OK -> nichts, vor 2:01 h -> Befund", () => {
    expect(evaluateWatchdog(input({ lastOkByJob: { fx: ago(1, 59) } }))).toEqual([]);
    expect(evaluateWatchdog(input({ lastOkByJob: { fx: ago(2, 1) } }))).toEqual([{ kind: "SCHEDULER_STALE", job: "fx", lastOkAt: ago(2, 1) }]);
  });

  it("nie gelaufener Job: erst 2 h nach Prozessstart ein Befund", () => {
    expect(evaluateWatchdog(input({ startedAt: ago(1, 59), lastOkByJob: { fx: null } }))).toEqual([]);
    expect(evaluateWatchdog(input({ startedAt: ago(2, 1), lastOkByJob: { fx: null } }))).toEqual([{ kind: "SCHEDULER_STALE", job: "fx", lastOkAt: null }]);
  });

  it("Sicherung: nicht konfiguriert -> nichts; 35 h -> nichts; 37 h -> Befund", () => {
    expect(evaluateWatchdog(input({ backup: { configured: false, lastOkAt: ago(500) } }))).toEqual([]);
    expect(evaluateWatchdog(input({ backup: { configured: true, lastOkAt: ago(35) } }))).toEqual([]);
    expect(evaluateWatchdog(input({ backup: { configured: true, lastOkAt: ago(37) } }))).toEqual([{ kind: "BACKUP_STALE", lastOkAt: ago(37) }]);
  });

  it("Sicherung konfiguriert, nie gelesen: erst 36 h nach Prozessstart ein Befund", () => {
    expect(evaluateWatchdog(input({ startedAt: ago(35), backup: { configured: true, lastOkAt: null } }))).toEqual([]);
    expect(evaluateWatchdog(input({ startedAt: ago(37), backup: { configured: true, lastOkAt: null } }))).toHaveLength(1);
  });

  it("Speicher: 0,149 -> Befund, 0,15 -> nichts, null -> nichts", () => {
    expect(evaluateWatchdog(input({ disks: [{ volume: "archive", freeRatio: 0.149 }] }))).toEqual([{ kind: "DISK_LOW", volume: "archive", freeRatio: 0.149 }]);
    expect(evaluateWatchdog(input({ disks: [{ volume: "attachments", freeRatio: 0.15 }] }))).toEqual([]);
    expect(evaluateWatchdog(input({ disks: [{ volume: "attachments", freeRatio: null }] }))).toEqual([]);
  });
});
