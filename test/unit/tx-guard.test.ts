import { describe, expect, it } from "vitest";
import { guardClient, GlobalClientInTransactionError } from "../helpers/tx-guard";

function fakeClient() {
  const tx = { thing: { findMany: async () => ["tx"] } };
  const client = {
    thing: { findMany: async () => ["global"] },
    $transaction: async <T>(arg: ((t: typeof tx) => Promise<T>) | Promise<unknown>[]) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(tx),
  };
  return client;
}

describe("Transaktions-Guard", () => {
  it("erlaubt den globalen Client ausserhalb und tx innerhalb der Transaktion", async () => {
    const c = guardClient(fakeClient());
    expect(await c.thing.findMany()).toEqual(["global"]);
    const inside = await c.$transaction(async (tx) => tx.thing.findMany());
    expect(inside).toEqual(["tx"]);
  });

  it("wirft bei Abfrage ueber den globalen Client innerhalb der Transaktion (auch nach await)", async () => {
    const c = guardClient(fakeClient());
    await expect(
      c.$transaction(async (tx) => {
        await tx.thing.findMany();
        return c.thing.findMany();
      }),
    ).rejects.toBeInstanceOf(GlobalClientInTransactionError);
  });

  it("erlaubt die Array-Form ausserhalb einer Transaktion", async () => {
    const c = guardClient(fakeClient());
    expect(await c.$transaction([Promise.resolve(1)])).toEqual([1]);
  });

  it("wirft bei Array-Form innerhalb eines interaktiven Callbacks", async () => {
    const c = guardClient(fakeClient());
    const p = Promise.resolve(1);
    await expect(c.$transaction(async () => c.$transaction([p]))).rejects.toBeInstanceOf(
      GlobalClientInTransactionError,
    );
  });
});
