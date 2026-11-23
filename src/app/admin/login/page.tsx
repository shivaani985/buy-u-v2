import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/auth/actions";
import { AdminLoginForm } from "@/components/auth/AdminLoginForm";
import { AuthFormShell } from "@/components/auth/AuthFormShell";
import { getSessionSummary } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Admin Sign In",
  description: "Dedicated Buy-U administrator sign-in portal.",
};

export default async function AdminLoginPage() {
  const session = await getSessionSummary();
  if (session.isActiveAdmin) {
    redirect("/admin");
  }

  return (
    <AuthFormShell
      title="Buy-U"
      accentWord="Admin Portal"
      subtitle="Restricted to backend-verified Buy-U administrators listed in admin_users. Regular UMS student and staff accounts cannot access this area."
      accentColor="purple"
    >
      {session.isAuthenticated ? (
        <div className="space-y-4">
          <div
            role="status"
            className="border border-[#4E2A84] bg-[#F8F4FC] p-4 text-sm text-[#14121A]"
          >
            <p className="font-bold text-[#4E2A84]">
              Signed in as regular UMS member ({session.email})
            </p>
            <p className="mt-1 text-[#4A4656]">
              Your marketplace session remains active. Regular student and staff
              accounts do not have administrator access.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/marketplace"
              className="bg-[#4E2A84] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#381C63] press-feedback"
            >
              Return to Marketplace
            </Link>
            <Link
              href="/account"
              className="border-2 border-[#14121A] bg-white px-4 py-2.5 text-sm font-bold text-[#14121A] hover:bg-[#F7F7F5]"
            >
              Go to Account
            </Link>
          </div>

          <div className="border-t border-[#E2E0E8] pt-4">
            <p className="mb-2 text-xs text-[#4A4656]">
              Need to sign in with a separate administrator account?
            </p>
            <form action={signOutAction}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 border border-[#14121A] bg-white px-3.5 py-2 text-xs font-bold text-[#14121A] hover:bg-[#14121A] hover:text-white"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Sign out current member session</span>
              </button>
            </form>
          </div>
        </div>
      ) : (
        <AdminLoginForm />
      )}
    </AuthFormShell>
  );
}
