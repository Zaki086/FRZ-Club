"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus, Trash2 } from "lucide-react";
import { api, ApiError, newIdempotencyKey, useApi } from "@/components/api";
import { Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { QuoteLines, useShopQuote } from "@/components/shop-quote";
import { clearCart, setCartQty, useCart } from "@/components/cart";
import { formatINR } from "@/lib/money";

type Me = { kind: string; role?: string; name?: string };
type CheckoutResult = { orderId: string; code: string; status: string; total: number; trackToken: string; payment: { redirectUrl: string } | null };

export function CartCheckout() {
  const router = useRouter();
  const cart = useCart();
  const me = useApi<Me>("/api/auth/me");
  const isMember = me.data?.kind === "USER" && me.data.role === "MEMBER";
  const isStaff = me.data?.kind === "USER" && me.data.role !== "MEMBER";
  const [fulfilment, setFulfilment] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  const [paymentOption, setPaymentOption] = useState<"ONLINE" | "PAY_AT_PICKUP">("ONLINE");
  const [address, setAddress] = useState("");
  const [guest, setGuest] = useState({ name: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [key] = useState(newIdempotencyKey);

  const items = useMemo(() => cart.map((l) => ({ variantId: l.variantId, qty: l.qty })), [cart]);
  const { quote, error: quoteError, loading } = useShopQuote(items.length ? { items, fulfilment } : null);
  const effectivePayment = isMember && fulfilment === "PICKUP" ? paymentOption : "ONLINE";

  if (!cart.length) {
    return <Empty title="Your cart is empty" hint="Browse rackets, balls, shoes and more." action={<Button asChild><Link href="/shop">Go to the shop</Link></Button>} />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader><CardTitle>Items</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="divide-y rounded-md border">
            {cart.map((l) => (
              <div key={l.variantId} className="flex items-center gap-2 p-2 text-sm">
                <span className="flex-1 font-medium">{l.name}</span>
                <Button size="icon" variant="outline" aria-label="Less" onClick={() => setCartQty(l.variantId, l.qty - 1)}><Minus className="h-4 w-4" /></Button>
                <span className="w-6 text-center tabular">{l.qty}</span>
                <Button size="icon" variant="outline" aria-label="More" onClick={() => setCartQty(l.variantId, l.qty + 1)}><Plus className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setCartQty(l.variantId, 0)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
          <QuoteLines quote={quote} error={quoteError} loading={loading} />
          {quoteError ? <Button variant="outline" size="sm" onClick={clearCart}>Clear cart</Button> : null}
          {isMember ? <p className="text-xs text-green-700">Signed in as {me.data?.name} — your member discount is included above.</p> : <p className="text-xs text-muted-foreground">Members: <Link className="underline" href="/login?next=/shop/cart">log in</Link> to get your plan discount.</p>}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Checkout</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isStaff ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">You are signed in as staff — staff sell at the counter POS. Log out to order as a visitor.</p> : null}
          <div className="grid grid-cols-2 gap-2">
            {(["PICKUP", "DELIVERY"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFulfilment(f)} className={cn("rounded-lg border p-3 text-left text-sm", fulfilment === f ? "border-primary bg-accent ring-2 ring-primary" : "hover:bg-muted")}>
                <p className="font-semibold">{f === "PICKUP" ? "Collect at the club" : "Deliver to me"}</p>
                <p className="text-xs text-muted-foreground">{f === "PICKUP" ? "Pick up at the shop counter" : "Flat delivery fee, shown in the total"}</p>
              </button>
            ))}
          </div>
          {fulfilment === "DELIVERY" ? (
            <Field label="Delivery address"><Textarea value={address} onChange={(e) => setAddress(e.target.value)} placeholder="House, street, area, city, PIN" /></Field>
          ) : null}
          {!isMember ? (
            <div className="flex flex-col gap-2">
              <Field label="Your name"><Input value={guest.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} autoComplete="name" /></Field>
              <Field label="Mobile" hint="10-digit Indian mobile"><Input inputMode="tel" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} autoComplete="tel" /></Field>
              <Field label="Email" hint="For order updates (optional)"><Input type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} autoComplete="email" /></Field>
            </div>
          ) : null}
          {isMember && fulfilment === "PICKUP" ? (
            <div className="grid grid-cols-2 gap-2">
              {(["ONLINE", "PAY_AT_PICKUP"] as const).map((p) => (
                <Button key={p} type="button" variant={paymentOption === p ? "default" : "outline"} onClick={() => setPaymentOption(p)}>
                  {p === "ONLINE" ? "Pay online now" : "Pay at pickup"}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Payment: online. Unpaid orders are released after a short hold.</p>
          )}
          {effectivePayment === "PAY_AT_PICKUP" ? <p className="text-xs text-muted-foreground">We hold your items for 48 hours; pay when you collect.</p> : null}
          <RejectionBanner error={error} />
          <Button
            size="lg"
            disabled={busy || !quote || isStaff}
            data-testid="checkout-submit"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<CheckoutResult>("/api/shop/checkout", {
                  body: {
                    items,
                    fulfilment,
                    address: fulfilment === "DELIVERY" ? address : undefined,
                    paymentOption: effectivePayment,
                    guest: isMember ? undefined : { name: guest.name, phone: guest.phone, email: guest.email || undefined },
                  },
                  idempotencyKey: key,
                });
                clearCart();
                if (r.payment) window.location.href = r.payment.redirectUrl;
                else router.push(`/orders/${r.trackToken}`);
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                setBusy(false);
              }
            }}
          >
            {busy ? "Placing order…" : quote ? `Place order · ${formatINR(quote.total)}` : "Place order"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
