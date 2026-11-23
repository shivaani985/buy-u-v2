"use client";

import { useActionState } from "react";
import { AlertCircle, CheckCircle2, Mail } from "lucide-react";
import {
  requestPasswordReset,
  type AuthActionState,
} from "@/app/auth/actions";

const INITIAL_STATE: AuthActionState = { status: "idle" };

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(
    requestPasswordReset,
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
          className="flex items-start gap-2.5 border border-[#00A3A6] bg-[#F2FAFA] p-3.5 text-sm text-[#14121A]"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#007D80]" aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      <div>
        <label
          htmlFor="forgot-email"
          className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
        >
          Account Email Address
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="UMS email or registered administrator email"
          className="mt-1.5 w-full border border-[#14121A] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:border-[#4E2A84]"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 bg-[#1D70B8] px-5 py-3 text-sm font-bold text-white hover:bg-[#14538A] disabled:opacity-60 press-feedback editorial-cut-tr"
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Sending link..." : "Send Password Reset Link"}</span>
      </button>
    </form>
  );
}
