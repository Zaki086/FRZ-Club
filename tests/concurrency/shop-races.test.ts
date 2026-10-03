import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { isDomainError } from "@/server/errors";
import { checkout, counterSale } from "@/server/services/shop";
import { makeWorld, type World } from "../helpers/world";
import { makeMember } from "../helpers/members";
import { makeProduct } from "../helpers/shop";
import { expectIntegrity } from "../helpers/integrity";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

describe("§10.2 concurrency — one shelf", () => {
  it("last unit of a racket: 10 parallel attempts mixed across counter sale and online checkout → exactly 1 success", async () => {
    const racket = await makeProduct(w, { name: "Last Racket", price: 1200000, onHand: 1, reorderLevel: 0 });
    const members = [];
    for (let i = 0; i < 5; i++) members.push(await makeMember(w, { name: `Online ${i}`, plan: "SILVER" }));
    const attempts = [
      ...members.map((m) => () => checkout(m.actor, { items: [{ variantId: racket.variantId, qty: 1 }], fulfilment: "PICKUP", paymentOption: "PAY_AT_PICKUP" })),
      ...Array.from({ length: 5 }, () => () => counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: racket.variantId, qty: 1 }], payments: [{ method: "CASH" }] })),
    ];
    const results = await Promise.allSettled(attempts.map((f) => f()));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const codes = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (isDomainError(r.reason) ? r.reason.code : String(r.reason)));
    expect(ok).toBe(1);
    expect(codes).toEqual(Array(9).fill("INSUFFICIENT_STOCK"));
    const v = await prisma.productVariant.findUniqueOrThrow({ where: { id: racket.variantId } });
    expect(v.onHand - v.reserved).toBe(0);
    await expectIntegrity();
  });
});
