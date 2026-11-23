import type { Metadata } from "next";
import Link from "next/link";
import { AuthFormShell } from "@/components/auth/AuthFormShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Set New Password",
  description: "Choose a new password for your Buy-U account.",
};

export default async function ResetPasswordPage() {
  const session = await getSessionSummary();

  return (
    <AuthFormShell
      title="Choose a new"
      accentWord="Password"
      subtitle="Enter a strong new password (at least 8 characters) to complete account recovery."
      accentColor="purple"
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
          className="border border-[#4E2A84] bg-[#F8F4FC] p-4 text-sm text-[#14121A]"
        >
          <p className="font-bold text-[#4E2A84]">
            Recovery session required
          </p>
          <p className="mt-1 text-[#4A4656]">
            Open the password recovery link sent to your UMS email inbox so your
            session is verified before updating your password.
          </p>
        </div>
      )}
    </AuthFormShell>
  );
}
