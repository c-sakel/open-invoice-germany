/**
 * Transaktions-Guard fuer Tests (Phase 17c, Pool-Deadlock-Audit).
 *
 * Innerhalb von `$transaction(async (tx) => ...)` duerfen Abfragen nie ueber den globalen
 * Client (`dbInternal`/`prisma`) laufen: bei erschoepftem Verbindungspool wartet die
 * Transaktion dann auf eine Verbindung, die nur andere (ebenfalls wartende) Transaktionen
 * halten (Deadlock bis Timeout). Der Guard umhuellt beide Clients per Proxy, merkt sich
 * ueber AsyncLocalStorage, ob gerade ein Transaktions-Callback laeuft, und wirft bei jeder
 * Abfrage ueber den globalen Client in diesem Kontext. Der `tx`-Client selbst ist nicht
 * umhuellt und bleibt erlaubt.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const txContext = new AsyncLocalStorage<{ depth: number }>();

export class GlobalClientInTransactionError extends Error {
  constructor(what: string) {
    super(`Abfrage ueber globalen Client innerhalb einer Transaktion: ${what} (stattdessen tx verwenden)`);
    this.name = "GlobalClientInTransactionError";
  }
}

type AnyFn = (...args: unknown[]) => unknown;

function assertOutsideTx(what: string): void {
  if (txContext.getStore()) throw new GlobalClientInTransactionError(what);
}

function wrapDelegate(model: string, delegate: object): object {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        assertOutsideTx(`${model}.${prop}`);
        return (value as AnyFn).apply(target, args);
      };
    },
  });
}

export function guardClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string") return value;
      if (prop === "$transaction") {
        return (arg: unknown, ...rest: unknown[]) => {
          if (typeof arg !== "function") return (value as AnyFn).call(target, arg, ...rest);
          const outer = txContext.getStore();
          return (value as AnyFn).call(
            target,
            (tx: unknown) => txContext.run({ depth: (outer?.depth ?? 0) + 1 }, () => (arg as AnyFn)(tx)),
            ...rest,
          );
        };
      }
      if (prop.startsWith("$")) {
        if (typeof value !== "function") return value;
        if (["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"].includes(prop)) {
          return (...args: unknown[]) => {
            assertOutsideTx(prop);
            return (value as AnyFn).apply(target, args);
          };
        }
        return (value as AnyFn).bind(target);
      }
      if (value && typeof value === "object") return wrapDelegate(prop, value);
      return value;
    },
  });
}
