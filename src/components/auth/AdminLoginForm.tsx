"use client";

import { useActionState } from "react";
import { AlertCircle, ShieldCheck } from "lucide-react";
import { signInAdmin, type AuthActionState } from "@/app/auth/actions";
import { PasswordInput } from "./PasswordInput";

const INITIAL_STATE: AuthActionState = { status: "idle" };

export function AdminLoginForm() {
  const [state, formAction, pending] = useActionState(
    signInAdmin,
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

      <div>
        <label
          htmlFor="admin-email"
          className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
        >
          Administrator Email
        </label>
        <input
          id="admin-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="admin@ums.edu.my"
          className="mt-1.5 w-full border border-[#14121A] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:border-[#4E2A84]"
        />
      </div>

      <PasswordInput
        id="admin-password"
        name="password"
        label="Password"
        autoComplete="current-password"
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 bg-[#14121A] px-5 py-3 text-sm font-bold text-white hover:bg-[#4E2A84] disabled:opacity-60 press-feedback editorial-cut-tr"
      >
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Verifying admin..." : "Sign in to Admin Portal"}</span>
      </button>
    </form>
  );
}
