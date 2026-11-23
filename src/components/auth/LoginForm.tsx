"use client";

import { useActionState } from "react";
import Link from "next/link";
import { AlertCircle, LogIn } from "lucide-react";
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
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={nextPath} />

      {errorMessage ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 border border-[#4E2A84] bg-[#F8F4FC] p-3.5 text-sm text-[#14121A]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#4E2A84]" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div>
        <label
          htmlFor="login-email"
          className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
        >
          UMS Email Address
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="student@iluv.ums.edu.my or staff@ums.edu.my"
          className="mt-1.5 w-full border border-[#14121A] bg-white px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:border-[#4E2A84]"
        />
      </div>

      <PasswordInput
        id="login-password"
        name="password"
        label="Password"
        autoComplete="current-password"
      />

      <div className="flex items-center justify-end">
        <Link
          href="/forgot-password"
          className="text-xs font-bold text-[#1D70B8] hover:text-[#4E2A84] hover:underline"
        >
          Forgot password?
        </Link>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 bg-[#4E2A84] px-5 py-3 text-sm font-bold text-white hover:bg-[#381C63] disabled:opacity-60 press-feedback editorial-cut-tr"
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        <span>{pending ? "Signing in..." : "Sign in to Buy-U"}</span>
      </button>
    </form>
  );
}
