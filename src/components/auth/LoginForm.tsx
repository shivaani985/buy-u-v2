"use client";

import { useActionState } from "react";
import Link from "next/link";
import { AlertCircle, LogIn, Mail } from "lucide-react";
import { signInMember, type AuthActionState } from "@/app/auth/actions";
import { PasswordInput } from "./PasswordInput";

interface LoginFormProps {
  nextPath: string;
  initialError?: string;
}

const INITIAL_STATE: AuthActionState = { status: "idle" };

export function LoginForm({ nextPath, initialError }: LoginFormProps) {
  const [state, formAction, pending] = useActionState(
    signInMember,
    INITIAL_STATE
  );

  const errorMessage =
    state.status === "error" ? state.message : initialError;

  return (
    <form action={formAction} className="space-y-3.5">
      <input type="hidden" name="next" value={nextPath} />

      {errorMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-[#F3B3B3] bg-[#FEF2F2] p-3 text-xs sm:text-sm text-[#991B1B]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div>
        <label
          htmlFor="login-email"
          className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-[#2E2A36]"
        >
          <Mail className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
          <span>UMS Email Address</span>
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="name@iluv.ums.edu.my or name@ums.edu.my"
          className="h-11 w-full rounded-xl border border-[#D5D0E0] bg-[#FAF9FD] px-3.5 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none transition-all duration-150 focus:border-[#4E2A84] focus:bg-white focus:ring-2 focus:ring-[#4E2A84]/20 [&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_#FAF9FD] focus:[&:-webkit-autofill]:shadow-[inset_0_0_0_1000px_#FFFFFF]"
        />
      </div>

      <PasswordInput
        id="login-password"
        name="password"
        label="Password"
        autoComplete="current-password"
        placeholder="Enter your password"
      />

      <div className="flex items-center justify-end">
        <Link
          href="/forgot-password"
          className="text-xs font-semibold text-[#008285] transition-colors hover:text-[#4E2A84] hover:underline"
        >
          Forgot password?
        </Link>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#4E2A84] px-5 text-sm font-bold text-white shadow-md shadow-[#4E2A84]/15 transition-all duration-150 hover:bg-[#3D1E6B] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Signing in..." : "Sign in to Buy-U"}</span>
      </button>
    </form>
  );
}
