"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { revealOrderCompletionPinAction } from "@/app/orders/actions";
import { OrderSection, orderButton, orderPrimary } from "@/components/orders/OrderDisplay";

export function CompletionPin({ orderId, mode }: { orderId: string; mode: "unified" | "legacy" }) {
  const router = useRouter();
  const [acknowledged, setAcknowledged] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const clearWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        request.current += 1;
        setPin(null);
        setBusy(false);
        setFeedback("");
        setAcknowledged(false);
      }
    };
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => document.removeEventListener("visibilitychange", clearWhenHidden);
  }, []);

  function clear() {
    request.current += 1;
    setPin(null);
    setBusy(false);
    setFeedback("");
  }

  async function reveal() {
    if (!acknowledged || busy) return;
    const current = ++request.current;
    setBusy(true);
    setFeedback("");
    try {
      const result = await revealOrderCompletionPinAction(orderId, acknowledged);
      if (request.current !== current) return;
      if (result.pin !== null) setPin(result.pin);
      else {
        setFeedback(result.error ?? "The PIN is no longer available.");
        router.refresh();
      }
    } catch {
      if (request.current === current) setFeedback("Could not retrieve the PIN. Try again.");
    } finally {
      if (request.current === current) setBusy(false);
    }
  }

  async function copy() {
    if (!pin) return;
    const current = request.current;
    try {
      await navigator.clipboard.writeText(pin);
      if (request.current === current) setFeedback("PIN copied.");
    } catch {
      if (request.current === current) setFeedback("Could not copy the PIN.");
    }
  }

  return (
    <OrderSection title="Order Completion PIN">
      <p className="text-sm leading-relaxed text-ink-secondary">
        {mode === "unified"
          ? "Only share this PIN after you have received your product or service and are satisfied with it. Once the seller verifies the PIN, your order will be marked as completed."
          : "Only share this PIN after you have received and checked your product or service. After the seller verifies it, return here to confirm receipt and complete the order."}
      </p>
      <label className="my-3 flex min-h-11 cursor-pointer items-start gap-2 text-sm font-semibold">
        <input type="checkbox" checked={acknowledged} className="mt-0.5 size-5 shrink-0 accent-brand-purple"
          onChange={(event) => { setAcknowledged(event.target.checked); if (!event.target.checked) clear(); }} />
        I have received and checked my product or service, and I am ready to complete this order.
      </label>
      <p aria-label={pin ? `Completion PIN ${pin.split("").join(" ")}` : "Completion PIN hidden"}
        className="mb-3 rounded-xl border border-[#DCD0F0] bg-[#F4F1FA] px-4 py-3 text-center font-mono text-xl font-extrabold tracking-[0.35em] tabular-nums text-[#4E2A84]">
        {pin ?? "••••••"}
      </p>
      <div className="flex flex-wrap gap-2">
        {pin ? <>
          <button type="button" className={orderButton} onClick={clear}>Hide PIN</button>
          <button type="button" className={orderPrimary} onClick={copy}>Copy PIN</button>
        </> : <button type="button" className={orderPrimary} disabled={!acknowledged || busy} onClick={reveal}>
          {busy ? "Revealing…" : "Reveal PIN"}
        </button>}
      </div>
      {feedback && <p role="status" className="mt-2 text-sm text-ink-secondary">{feedback}</p>}
    </OrderSection>
  );
}
