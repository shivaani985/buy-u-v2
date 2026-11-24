import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/auth/AuthLayout";
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
    <AuthLayout
      title="Create your"
      accentWord="Buy-U account"
      subtitle="Register with your official Universiti Malaysia Sabah student or staff email to join the UMSKAL campus marketplace."
      footer={
        <p>
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-bold text-[#4E2A84] hover:underline"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <RegisterForm />
    </AuthLayout>
  );
}
