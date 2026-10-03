// What happens when a bill becomes fully PAID. Each module owns its reaction; modules are loaded lazily so the
// payments module never forms an import cycle with the modules that call it.
import type { Bill } from "@prisma/client";
import type { Tx } from "../db";
import type { Actor } from "../rbac/actor";

export async function onBillPaid(tx: Tx, bill: Bill, actor: Actor): Promise<void> {
  switch (bill.sourceType) {
    case "MEMBERSHIP": {
      const { onMembershipBillPaid } = await import("./membership");
      return onMembershipBillPaid(tx, bill, actor);
    }
    case "SHOP_ORDER": {
      const { onShopOrderPaid } = await import("./shop");
      return onShopOrderPaid(tx, bill.id, actor);
    }
    case "INVOICE": {
      const { onInvoiceBillPaid } = await import("./invoices");
      return onInvoiceBillPaid(tx, bill, actor);
    }
    default:
      // Bookings, social joins, counter sales, tabs and service tickets need no extra step: their state
      // already reflects the bill, and check-in / handover read the bill's balance directly.
      return;
  }
}

/** Called after every payment or refund on a bill (partial payments move invoices to PARTIALLY_PAID). */
export async function onBillPaymentChanged(tx: Tx, bill: Bill): Promise<void> {
  if (bill.sourceType === "INVOICE") {
    const { syncInvoiceStatus } = await import("./invoices");
    await syncInvoiceStatus(tx, bill.id);
  }
}
