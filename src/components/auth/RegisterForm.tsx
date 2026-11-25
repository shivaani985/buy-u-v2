"use client";

import { useActionState } from "react";
import { AlertCircle, CheckCircle2, Mail, User, UserPlus } from "lucide-react";
import { registerMember, type AuthActionState } from "@/app/auth/actions";
import { PasswordInput } from "./PasswordInput";

const INITIAL_STATE: AuthActionState = { status: "idle" };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(
    registerMember,
    INITIAL_STATE
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-[#F3B3B3] bg-[#FEF2F2] p-3 text-xs sm:text-sm text-[#991B1B]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      {state.status === "success" && state.message ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] p-3 text-xs sm:text-sm text-[#065F46]"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#059669]" aria-hidden="true" />
          <span>{state.message}</span>
        </div>
      ) : null}

      <div>
        <label
          htmlFor="register-name"
          className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-[#2E2A36]"
        >
          <User className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
          <span>Display Name</span>
        </label>
        <input
          id="register-name"
          name="displayName"
          type="text"
          autoComplete="name"
          required
          minLength={2}
          placeholder="How other UMSKAL members see you"
          className="h-11 w-full rounded-xl border border-[#D5D0E0] bg-[#FAF9FD] px-3.5 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none transition-all duration-150 focus:border-[#4E2A84] focus:bg-white focus:ring-2 focus:ring-[#4E2A84]/20 [&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_#FAF9FD] focus:[&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_#FFFFFF]"
        />
      </div>

      <div>
        <label
          htmlFor="register-email"
          className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-[#2E2A36]"
        >
          <Mail className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
          <span>Official UMS Email</span>
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="name@iluv.ums.edu.my or name@ums.edu.my"
          className="h-11 w-full rounded-xl border border-[#D5D0E0] bg-[#FAF9FD] px-3.5 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none transition-all duration-150 focus:border-[#4E2A84] focus:bg-white focus:ring-2 focus:ring-[#4E2A84]/20 [&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_#FAF9FD] focus:[&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_#FFFFFF]"
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
        className="mt-1 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-5 text-sm font-bold text-white shadow-md shadow-[#4E2A84]/15 transition-all duration-150 hover:bg-[#3D1E6B] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Creating account..." : "Create Buy-U Account"}</span>
      </button>
    </form>
  );
}
