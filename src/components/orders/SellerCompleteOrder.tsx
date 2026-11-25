"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Eye, EyeOff, KeyRound, X } from "lucide-react";
import { verifySellerPickupPinAction } from "@/app/orders/actions";
import { normalizePickupPinInput } from "@/lib/orders/lifecycle";
import { formatMytDateTime } from "@/lib/financials/policy";
import { orderButton, orderPrimary } from "@/components/orders/OrderDisplay";

export function SellerCompleteOrder({
  id,
  code,
  mode,
  lockedUntil,
  failedAttempts,
  now,
  eligible,
  onSuccess,
}: {
  id: string;
  code: string;
  mode: "unified" | "legacy" | "unavailable";
  lockedUntil: string | null;
  failedAttempts: number;
  now: number;
  eligible: boolean;
  onSuccess?: (message: string) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const inputId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState("");
  const [lock, setLock] = useState(lockedUntil);
  const [attempts, setAttempts] = useState(failedAttempts);

  const locked = Boolean(lock && Date.parse(lock) > now);
  const legacy = mode === "legacy";

  const closeDialog = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setPin("");
    setShowPin(false);
    setMessage("");
  }, [busy]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - html.clientWidth;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const rafId = window.requestAnimationFrame(() => {
      if (!locked) {
        inputRef.current?.focus({ preventScroll: true });
      }
    });

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (busy) return;
        e.preventDefault();
        closeDialog();
        return;
      }

      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(rafId);
      document.removeEventListener("keydown", handleKeyDown);
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.paddingRight = prevBodyPaddingRight;

      const triggerEl = triggerRef.current;
      if (triggerEl && triggerEl.isConnected) {
        window.requestAnimationFrame(() => {
          triggerEl.focus({ preventScroll: true });
        });
      }
    };
  }, [open, busy, locked, closeDialog]);

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pin.length !== 6 || locked || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await verifySellerPickupPinAction(id, pin);
      setPin("");
      if (result.ok) {
        setSuccess(result.message);
        onSuccess?.(result.message);
        setOpen(false);
        router.refresh();
      } else {
        setMessage(result.message);
        if (result.failedAttempts !== undefined) setAttempts(result.failedAttempts);
        if (result.lockedUntil) setLock(result.lockedUntil);
      }
    } catch {
      setMessage("The PIN could not be checked. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {eligible && mode !== "unavailable" && !success ? (
        <button
          ref={triggerRef}
          type="button"
          className={orderPrimary}
          onClick={() => {
            setPin("");
            setShowPin(false);
            setMessage("");
            setOpen(true);
          }}
        >
          {legacy ? "Verify PIN" : "Complete Order"}
        </button>
      ) : null}

      {success && !onSuccess ? (
        <p role="status" className="text-sm font-semibold text-[#027A48]">
          {success}
        </p>
      ) : null}

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
              role="presentation"
            >
              <div
                aria-hidden="true"
                onClick={closeDialog}
                className="anim-backdrop-in fixed inset-0 bg-[#14121A]/45 backdrop-blur-[2px]"
              />

              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="anim-modal-sheet relative z-10 w-full overflow-hidden rounded-t-2xl border border-[#E6E3EE] bg-white shadow-2xl sm:max-w-md sm:rounded-2xl"
              >
                <form onSubmit={complete}>
                  {/* Modal Header */}
                  <div className="border-b border-[#ECEAF2] px-5 pt-2.5 pb-3.5 sm:pt-4">
                    <div
                      aria-hidden="true"
                      className="mx-auto mb-2.5 h-1 w-10 rounded-full bg-[#D8D3E6] sm:hidden"
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F4F1FA] text-[#4E2A84]">
                          <KeyRound className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                          <h2
                            id={titleId}
                            className="text-base font-extrabold italic tracking-[-0.01em] text-[#111018] sm:text-lg"
                          >
                            {legacy ? "Verify Pickup PIN" : "Complete Order"}
                          </h2>
                          <p className="mt-0.5 text-xs text-[#6E6A7C]">
                            Order{" "}
                            <span className="font-mono font-bold text-[#4E2A84]">
                              #{code}
                            </span>
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={closeDialog}
                        aria-label="Close complete order dialog"
                        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[#6E6A7C] transition hover:bg-[#F5F4F8] hover:text-[#14121A] disabled:opacity-50 press-feedback"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {/* Modal Body */}
                  <div className="space-y-4 px-5 py-4">
                    <p className="text-xs leading-relaxed text-[#4A4656] sm:text-sm">
                      Enter the six-digit completion PIN provided by your customer
                      after they have received their product or service.
                      {legacy
                        ? " The buyer will then confirm receipt to complete the order."
                        : ""}
                    </p>

                    <div className="space-y-1.5">
                      <label
                        htmlFor={inputId}
                        className="block text-[11px] font-extrabold uppercase tracking-wider text-[#555062]"
                      >
                        Six-digit PIN
                      </label>
                      <div className="relative flex items-center rounded-xl border border-[#CFCBD9] bg-[#FAFAFC] transition-colors focus-within:border-[#4E2A84] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#4E2A84]/15">
                        <input
                          ref={inputRef}
                          id={inputId}
                          autoComplete="off"
                          inputMode="numeric"
                          pattern="[0-9]{6}"
                          maxLength={6}
                          required
                          value={pin}
                          type={showPin ? "text" : "password"}
                          placeholder="••••••"
                          disabled={locked || busy}
                          onChange={(event) =>
                            setPin(normalizePickupPinInput(event.target.value))
                          }
                          className="min-h-12 w-full bg-transparent px-4 py-2.5 pr-11 text-center font-mono text-xl font-extrabold tracking-[0.38em] text-[#14121A] placeholder:tracking-[0.38em] placeholder:text-[#B5B0C4] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPin((v) => !v)}
                          aria-label={showPin ? "Hide PIN" : "Show PIN"}
                          className="absolute right-2.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[#6E6A7C] transition hover:bg-[#EFEAF8] hover:text-[#4E2A84]"
                        >
                          {showPin ? (
                            <EyeOff className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <Eye className="h-4 w-4" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      {attempts > 0 && attempts < 5 && !message && !locked ? (
                        <p className="text-xs font-semibold text-[#6E6A7C]">
                          {5 - attempts}{" "}
                          {5 - attempts === 1 ? "attempt" : "attempts"} remaining
                        </p>
                      ) : null}
                    </div>

                    {locked ? (
                      <div
                        role="status"
                        className="flex items-start gap-2 rounded-xl border border-[#F5C2C0] bg-[#FDF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#B42318]"
                      >
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          Too many failed attempts. Try again after{" "}
                          {formatMytDateTime(lock)}.
                        </span>
                      </div>
                    ) : null}

                    {message ? (
                      <div
                        role="alert"
                        className="flex items-start gap-2 rounded-xl border border-[#F5C2C0] bg-[#FDF2F2] px-3.5 py-2.5 text-xs font-semibold text-[#B42318]"
                      >
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{message}</span>
                      </div>
                    ) : null}
                  </div>

                  {/* Modal Footer */}
                  <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-[#ECEAF2] bg-[#FAFAFC]/80 px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
                    <button
                      type="button"
                      className={orderButton}
                      disabled={busy}
                      onClick={closeDialog}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className={orderPrimary}
                      disabled={pin.length !== 6 || locked || busy}
                    >
                      {busy
                        ? "Verifying…"
                        : legacy
                          ? "Verify PIN"
                          : "Verify & Complete Order"}
                    </button>
                  </div>
                </form>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
