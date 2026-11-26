"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { retryCheckoutSandboxBillAction, retryOrderSandboxBillAction } from "@/app/checkout/actions";
import { startConversationAction } from "@/app/messages/actions";
import { LATE_PAYMENT_GUIDANCE } from "@/lib/orders/lifecycle";
import { orderButton, orderPrimary } from "@/components/orders/OrderDisplay";

export function PaymentControls({ checkoutId, orderId, deadline, now, underReview, canPay, showStatus = false }: {
  checkoutId?: string; orderId?: string; deadline: string | null; now: number;
  underReview: boolean; canPay: boolean; showStatus?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"pay" | "verify" | null>(null);
  const [message, setMessage] = useState("");
  const remaining = deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : null;
  const expired = remaining === 0;
  async function run(mode: "pay" | "verify") {
    setMessage("");
    setBusy(mode);
    try {
      if (mode === "verify") {
        const response = await fetch("/api/payments/toyyibpay/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(checkoutId ? { checkoutSessionId: checkoutId } : { orderId }),
        });
        const result = await response.json();
        setMessage(result.message ?? result.error ?? "Payment status checked.");
      } else {
        const result = checkoutId ? await retryCheckoutSandboxBillAction(checkoutId) : await retryOrderSandboxBillAction(orderId ?? "");
        if (result.ok && result.billUrl) {
          window.location.assign(result.billUrl);
          return;
        }
        setMessage(result.error ?? "Unable to open ToyyibPay. Try checking your payment status.");
      }
      router.refresh();
    } catch {
      setMessage("Could not reach the payment service. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (underReview) return <p className="max-w-prose text-sm text-amber-900">{LATE_PAYMENT_GUIDANCE}</p>;
  if (!canPay && !showStatus) return null;
  return (
    <div className="space-y-2">
      {canPay && remaining !== null && (
        <p role={remaining === 300 || expired ? "status" : undefined} className={`tabular-nums text-xs font-semibold ${remaining <= 300 ? "text-red-800" : "text-ink-secondary"}`}>
          {expired ? "Payment Expired" : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} remaining${remaining <= 300 ? " · Payment due soon" : ""}`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canPay && !expired && (
          <button type="button" className={orderPrimary} disabled={Boolean(busy)} onClick={() => run("pay")}>
            {busy === "pay" ? "Opening ToyyibPay…" : "Pay Now"}
          </button>
        )}
        {showStatus && (
          <button type="button" className={orderButton} disabled={Boolean(busy)} onClick={() => run("verify")}>
            {busy === "verify" ? "Checking…" : "Check Payment Status"}
          </button>
        )}
      </div>
      {message && <p role="status" className="max-w-prose text-sm text-ink-secondary">{message}</p>}
    </div>
  );
}

export function OrderContact({ orderId, orderItemId, recipientId, seller }: {
  orderId: string; orderItemId?: string; recipientId: string; seller?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function contact() {
    setBusy(true);
    setError("");
    try {
      const result = await startConversationAction({
        sellerId: recipientId, orderId, orderItemId,
      });
      if (result.ok && result.href) router.push(result.href);
      else setError(result.error ?? "Could not open this conversation.");
    } catch {
      setError("Could not open this conversation.");
    } finally {
      setBusy(false);
    }
  }
  return <div>
    <button type="button" className={orderItemId
      ? "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-bold text-brand-purple hover:bg-[#F4F1FA] disabled:opacity-50"
      : orderButton} onClick={contact} disabled={busy}>
      <MessageCircle className="size-4" aria-hidden="true" />{busy ? "Opening chat…" : orderItemId ? "Chat about item" : seller ? "Contact Buyer" : "Contact Seller"}
    </button>
    {error && <p role="alert" className="mt-1 max-w-60 text-xs text-red-800">{error}</p>}
  </div>;
}
