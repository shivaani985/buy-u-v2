"use client";

import { useActionState } from "react";
import { AlertCircle, CheckCircle2, UserPlus } from "lucide-react";
import { registerMember, type AuthActionState } from "@/app/auth/actions";
import { PasswordInput } from "./PasswordInput";

const INITIAL_STATE: AuthActionState = { status: "idle" };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(
    registerMember,
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

      <div className="border border-[#D9D6E2] bg-[#F7F7F5] p-3.5 text-xs leading-relaxed text-[#4A4656]">
        <p className="font-bold text-[#14121A]">
          University role is assigned automatically by the backend:
        </p>
        <p className="mt-1">
          Students: <code className="font-mono text-[#4E2A84]">@iluv.ums.edu.my</code>{" "}
          (can buy &amp; sell) · Staff:{" "}
          <code className="font-mono text-[#007D80]">@ums.edu.my</code> (browse,
          buy &amp; request services; cannot sell).
        </p>
      </div>

      <div>
        <label
          htmlFor="register-name"
          className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
        >
          Display Name
        </label>
        <input
          id="register-name"
          name="displayName"
          type="text"
          autoComplete="name"
          required
          minLength={2}
          placeholder="How other UMSKAL members see you"
          className="mt-1.5 w-full border border-[#14121A] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:border-[#4E2A84]"
        />
      </div>

      <div>
        <label
          htmlFor="register-email"
          className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
        >
          Official UMS Email
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="name@iluv.ums.edu.my or name@ums.edu.my"
          className="mt-1.5 w-full border border-[#14121A] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:border-[#4E2A84]"
        />
      </div>

      <PasswordInput
        id="register-password"
        name="password"
        label="Password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        minLength={8}
      />

      <PasswordInput
        id="register-confirm"
        name="confirmPassword"
        label="Confirm Password"
        autoComplete="new-password"
        placeholder="Re-enter password"
        minLength={8}
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 bg-[#007D80] px-5 py-3 text-sm font-bold text-white hover:bg-[#006163] disabled:opacity-60 press-feedback editorial-cut-tr"
      >
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Creating account..." : "Create UMS Account"}</span>
      </button>
    </form>
  );
}
