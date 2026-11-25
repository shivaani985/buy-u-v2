"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Trash2, X } from "lucide-react";
import { deleteListingAction } from "@/app/seller/actions";

interface DeleteListingButtonProps {
  listingId: string;
  listingTitle: string;
  variant?: "inline" | "button";
  redirectTo?: string;
}

export function DeleteListingButton({
  listingId,
  listingTitle,
  variant = "inline",
  redirectTo,
}: DeleteListingButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirmDelete() {
    setError(null);
    startTransition(async () => {
      const res = await deleteListingAction(listingId);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setOpen(false);
      if (redirectTo) {
        router.push(redirectTo);
      }
      router.refresh();
    });
  }

  return (
    <>
      {variant === "button" ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#F3C6C6] bg-white px-4 py-2 text-xs font-bold text-[#B42318] hover:bg-[#FEF2F2] press-feedback"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Delete Listing</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          className="font-semibold text-[#B42318] hover:underline"
        >
          Delete
        </button>
      )}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`del-title-${listingId}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 text-left"
        >
          <div className="w-full max-w-md rounded-2xl border border-[#E6E3EE] bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FEF2F2] text-[#B42318]">
                  <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2
                    id={`del-title-${listingId}`}
                    className="text-base font-extrabold text-[#14121A]"
                  >
                    Delete Listing?
                  </h2>
                  <p className="mt-0.5 text-xs text-[#6E6A7C]">
                    This action cannot be undone.
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setOpen(false)}
                aria-label="Cancel delete"
                className="rounded-lg p-1 text-[#6E6A7C] hover:bg-[#F5F4F8]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-[#4A4656]">
              Are you sure you want to permanently delete{" "}
              <span className="font-bold text-[#14121A]">
                &ldquo;{listingTitle}&rdquo;
              </span>
              ?
            </p>

            {error ? (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-[#F3C6C6] bg-[#FEF2F2] px-3 py-2 text-xs font-semibold text-[#B42318]"
              >
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2.5">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setOpen(false)}
                className="rounded-xl border border-[#E6E3EE] bg-white px-4 py-2 text-xs font-bold text-[#14121A] hover:bg-[#FAFAFC]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleConfirmDelete}
                className="rounded-xl bg-[#B42318] px-4 py-2 text-xs font-bold text-white hover:bg-[#912018] disabled:opacity-60"
              >
                {isPending ? "Deleting..." : "Yes, Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
