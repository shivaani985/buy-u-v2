import type { Metadata } from "next";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Set New Password",
  description: "Choose a new password for your Buy-U account.",
};

export default async function ResetPasswordPage() {
  const session = await getSessionSummary();

  return (
    <AuthLayout
      title="Choose a new"
      accentWord="Password"
      subtitle="Enter a strong new password (at least 8 characters) to complete your account recovery."
      footer={
        <p>
          Need a fresh link?{" "}
          <Link
            href="/forgot-password"
            className="font-bold text-[#4E2A84] hover:underline"
          >
            Request password reset
          </Link>
        </p>
      }
    >
      {session.isAuthenticated ? (
        <ResetPasswordForm />
      ) : (
        <div
          role="alert"
          className="rounded-xl border border-[#F3B3B3] bg-[#FEF2F2] p-4 text-sm text-[#991B1B]"
        >
          <p className="font-bold text-[#991B1B]">
            Recovery session required
          </p>
          <p className="mt-1 text-xs text-[#7F1D1D] leading-relaxed">
            Open the password recovery link sent to your UMS email inbox so your
            session is verified before updating your password.
          </p>
        </div>
      )}
    </AuthLayout>
  );
}
