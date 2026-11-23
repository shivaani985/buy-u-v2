import type { Metadata } from "next";
import Link from "next/link";
import { AuthFormShell } from "@/components/auth/AuthFormShell";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Forgot Password",
  description: "Request a password reset link for your UMS Buy-U account.",
};

export default function ForgotPasswordPage() {
  return (
    <AuthFormShell
      title="Reset your"
      accentWord="Password"
      subtitle="Enter your UMS email address and we will send a secure password recovery link."
      accentColor="blue"
      footer={
        <p>
          Remembered your password?{" "}
          <Link
            href="/login"
            className="font-bold text-[#1D70B8] hover:underline"
          >
            Back to Sign In
          </Link>
        </p>
      }
    >
      <ForgotPasswordForm />
    </AuthFormShell>
  );
}
