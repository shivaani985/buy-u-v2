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
          className="flex items-start gap-2.5 border border-[#4E2A84] bg-[#F8F4FC] p-3.5 text-sm text-[#14121A]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#4E2A84]" aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      {state.status === "success" && state.message ? (
        <div
          role="status"
          className="space-y-2 border border-[#00A3A6] bg-[#F2FAFA] p-3.5 text-sm text-[#14121A]"
        >
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#007D80]" aria-hidden="true" />
            <span>{state.message}</span>
          </div>
          <Link
            href="/account"
            className="inline-block font-bold text-[#4E2A84] underline"
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
        className="inline-flex w-full items-center justify-center gap-2 bg-[#4E2A84] px-5 py-3 text-sm font-bold text-white hover:bg-[#381C63] disabled:opacity-60 press-feedback editorial-cut-tr"
      >
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Updating..." : "Update Password"}</span>
      </button>
    </form>
  );
}
