import type { Metadata } from "next";
import { CartCheckout } from "./cart-checkout";

export const metadata: Metadata = { title: "Cart" };

export default function CartPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="mb-4 text-3xl font-bold">Your cart</h1>
      <CartCheckout />
    </div>
  );
}
