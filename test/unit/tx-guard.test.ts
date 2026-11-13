import { describe, expect, it } from "vitest";
import { guardClient, GlobalClientInTransactionError } from "../helpers/tx-guard";

function fakeClient() {
  const tx = { thing: { findMany: async () => ["tx"] } };
  const client = {
    thing: { findMany: async () => ["global"] },
    $transaction: async <T>(cb: (t: typeof tx) => Promise<T>) => cb(tx),
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
});
