import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthFormShell } from "@/components/auth/AuthFormShell";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Register",
  description: "Register a verified UMS student or staff account on Buy-U.",
};

export default async function RegisterPage() {
  const session = await getSessionSummary();
  if (session.isActiveMember) {
    redirect("/account");
  }

  return (
    <AuthFormShell
      title="Join"
      accentWord="UMSKAL"
      subtitle="Create your Buy-U account with your official UMS email. Email verification is required before member access is enabled."
      accentColor="teal"
      footer={
        <p>
          Already have a verified UMS account?{" "}
          <Link
            href="/login"
            className="font-bold text-[#007D80] hover:underline"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <RegisterForm />
    </AuthFormShell>
  );
}
