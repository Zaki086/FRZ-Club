// Completion pass phase 4 (§9 carried-over fixes): GST correctness (alcohol outside GST, GSTR-1 working tables,
// Tally day book), product photos only from the club's own uploads.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { exportCsv, gstReport, gstr1, tallyRows } from "@/server/services/reports";
import { addLines, openTab, settleTab } from "@/server/services/bar";
import { counterSale, createProduct, setProductImage } from "@/server/services/shop";
import { createClient, createDraft, issueInvoice } from "@/server/services/invoices";
import { recordCounterPayment } from "@/server/services/payments";
import { saveUpload } from "@/server/services/uploads";
import { setCapabilityOverridesForTests } from "@/server/services/capabilities";
import { makeWorld, type World } from "../helpers/world";
import { makeBar } from "../helpers/bar";
import { makeProduct } from "../helpers/shop";

let w: World;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

beforeEach(async () => {
  w = await makeWorld();
});

async function sales() {
  const bar = await makeBar(w);
  const t = await openTab(w.actors.BAR_STAFF, { guest: { name: "Adult Arun" }, guestIdVerified: true });
  await addLines(w.actors.BAR_STAFF, t.tabId, { items: [{ menuItemId: bar.beer.id, qty: 1 }, { menuItemId: bar.fries.id, qty: 1 }] });
  await settleTab(w.actors.BAR_STAFF, t.tabId, { payments: [{ method: "CASH", amount: 35000 + 18000 }] });
  const racket = await makeProduct(w, { name: "Junior racket", category: "RACKETS", price: 200000, onHand: 3 });
  await counterSale(w.actors.SHOP_STAFF, { items: [{ variantId: racket.variantId, qty: 1 }], payments: [{ method: "CASH" }] });
  const mum = await createClient(w.actors.ACCOUNTANT, { name: "Mumbai Corp", gstin: "27AAPFU0939F1ZV", address: "Nariman Point, Mumbai", contactName: "Ravi" });
  const d = await createDraft(w.actors.ACCOUNTANT, { businessClientId: mum.id, lines: [{ kind: "MANUAL", description: "Corporate package", qty: 1, unitPrice: 1_180_000 }] });
  await issueInvoice(w.actors.ACCOUNTANT, d.invoice.id);
  await recordCounterPayment(w.actors.ACCOUNTANT, { billId: d.bill.id, method: "BANK_TRANSFER", amount: 1_180_000, reference: "NEFT-0001" });
}

describe("Completion §9 — GST correctness", () => {
  it("alcohol is outside GST: listed separately and never in the GST totals", async () => {
    await sales();
    const g = await gstReport(w.actors.ACCOUNTANT, { period: "TODAY" });
    expect(g.rows.some((r) => r.category === "OUTSIDE_GST")).toBe(false);
    expect(g.outsideGst).toBe(35000);
    expect(g.rows.find((r) => r.category === "GOODS_5")?.rate).toBe(5); // the racket (HSN 9506)
    expect(g.rows.find((r) => r.category === "RESTAURANT")?.rate).toBe(5);
  });

  it("GSTR-1 tables: B2B per invoice with IGST and the place of supply; B2CS per rate; HSN summary; non-GST total", async () => {
    await sales();
    const r = await gstr1(w.actors.ACCOUNTANT, { period: "TODAY" });
    expect(r.b2b).toHaveLength(1);
    expect(r.b2b[0]).toMatchObject({ gstin: "27AAPFU0939F1ZV", pos: "27-Maharashtra", rate: 18, taxable: 1_000_000, igst: 180_000, cgst: 0, sgst: 0 });
    expect(r.b2cs.map((x) => x.rate)).toEqual([5]);
    expect(r.b2cs[0].pos).toBe("24-Gujarat");
    expect(r.nonGst).toBe(35000);
    expect(r.hsn.find((h) => h.hsn === "9506")).toMatchObject({ rate: 5, qty: 1, value: 200000 });
    const csv = await exportCsv(w.actors.ACCOUNTANT, "gstr1_b2b", { period: "TODAY" });
    expect(csv.split("\n")[0]).toBe("GSTIN/UIN of Recipient,Receiver Name,Invoice Number,Invoice date,Invoice Value,Place Of Supply,Reverse Charge,Invoice Type,Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax");
    expect(csv).toContain("27AAPFU0939F1ZV,Mumbai Corp,");
    await expect(gstr1(w.actors.BAR_STAFF, { period: "TODAY" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("without GST there is no GST report (CAPABILITY_DISABLED)", async () => {
    setCapabilityOverridesForTests({ gst: false, email: true });
    await expect(gstReport(w.actors.ACCOUNTANT, { period: "TODAY" })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    await expect(gstr1(w.actors.ACCOUNTANT, { period: "TODAY" })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
  });

  it("Tally day book: receipts per ledger account with the cash/bank ledger; totals match the ledger", async () => {
    await sales();
    const rows = await tallyRows(w.actors.ACCOUNTANT, { period: "TODAY" });
    expect(rows.find((r) => r.ledger === "Corporate Invoices")).toMatchObject({ voucherType: "Receipt", cashBank: "Bank Account", amount: "11800.00", drCr: "Cr" });
    expect(rows.filter((r) => r.ledger === "Bar & Cafe Sales").map((r) => r.cashBank)).toEqual(["Cash"]);
    const ledger = await prisma.ledgerEntry.aggregate({ _sum: { amount: true } });
    const sum = rows.reduce((a, r) => a + Math.round(Number(r.amount) * 100) * (r.drCr === "Cr" ? 1 : -1), 0);
    expect(sum).toBe(ledger._sum.amount);
  });
});

describe("Completion §9 — product photos", () => {
  it("only the club's own uploaded photos; a remote URL is refused", async () => {
    await expect(
      createProduct(w.actors.SHOP_STAFF, { name: "Hotlinked", category: "BALLS", imageUrl: "https://example.com/ball.jpg", variants: [{ sku: "BAL-HOT", price: 10000, hsnSac: "9506" }] }),
    ).rejects.toThrow(/Upload the product photo first/);
    const p = await makeProduct(w, { name: "Photo ball", category: "BALLS", price: 10000, onHand: 1 });
    const up = await saveUpload(w.actors.SHOP_STAFF, "product", PNG);
    expect((await setProductImage(w.actors.SHOP_STAFF, p.productId, up.url)).imageUrl).toBe(up.url);
    await expect(setProductImage(w.actors.SHOP_STAFF, p.productId, "/api/uploads/expense/aaaaaaaaaaaaaaaaaaaaaaaa.png")).rejects.toThrow();
    expect((await setProductImage(w.actors.SHOP_STAFF, p.productId, null)).imageUrl).toBeNull();
    await expect(setProductImage(w.actors.BAR_STAFF, p.productId, up.url)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
