"use client";

import { useActionState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, KeyRound } from "lucide-react";
import { updatePassword, type AuthActionState } from "@/app/auth/actions";
import { PasswordInput } from "./PasswordInput";

const INITIAL_STATE: AuthActionState = { status: "idle" };

export function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState(
    updatePassword,
    INITIAL_STATE
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-[#F3B3B3] bg-[#FEF2F2] p-3.5 text-sm text-[#991B1B]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      {state.status === "success" && state.message ? (
        <div
          role="status"
          className="space-y-2.5 rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] p-3.5 text-sm text-[#065F46]"
        >
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#059669]" aria-hidden="true" />
            <span>{state.message}</span>
          </div>
          <Link
            href="/account"
            className="inline-block font-bold text-[#4E2A84] hover:underline"
          >
            Go to Account
          </Link>
        </div>
      ) : null}

      <PasswordInput
        id="reset-password"
        name="password"
        label="New Password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        minLength={8}
      />

      <PasswordInput
        id="reset-confirm"
        name="confirmPassword"
        label="Confirm New Password"
        autoComplete="new-password"
        placeholder="Re-enter new password"
        minLength={8}
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-5 py-3.5 text-sm font-bold text-white shadow-md shadow-[#4E2A84]/15 transition-all duration-150 hover:bg-[#3D1E6B] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Updating password..." : "Update Password"}</span>
      </button>
    </form>
  );
}
