import type { Metadata } from "next";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Forgot Password",
  description: "Request a password reset link for your UMS Buy-U account.",
};

export default function ForgotPasswordPage() {
  return (
    <AuthLayout
      title="Forgot your"
      accentWord="Password?"
      subtitle="Enter your verified UMS email address and we will send a secure password recovery link to your inbox."
      footer={
        <p>
          Remembered your password?{" "}
          <Link
            href="/login"
            className="font-bold text-[#4E2A84] hover:underline"
          >
            Back to Sign In
          </Link>
        </p>
      }
    >
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
