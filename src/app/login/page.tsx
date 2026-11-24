import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { LoginForm } from "@/components/auth/LoginForm";
import { sanitizeNextPath } from "@/lib/auth/validation";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to Buy-U with your verified UMS university email.",
};

interface LoginPageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [session, sp] = await Promise.all([getSessionSummary(), searchParams]);
  const nextPath = sanitizeNextPath(sp.next, "/marketplace");

  if (session.isActiveMember) {
    redirect(nextPath);
  }

  return (
    <AuthLayout
      title="Sign in to"
      accentWord="Buy-U"
      subtitle="Use your official Universiti Malaysia Sabah student (@iluv.ums.edu.my) or staff (@ums.edu.my) account to access the Buy-U marketplace."
      footer={
        <p>
          New to Buy-U?{" "}
          <Link
            href="/register"
            className="font-bold text-[#4E2A84] hover:underline"
          >
            Create a UMS account
          </Link>
        </p>
      }
    >
      <LoginForm
        nextPath={nextPath}
        initialError={typeof sp.error === "string" ? sp.error : undefined}
      />
    </AuthLayout>
  );
}
