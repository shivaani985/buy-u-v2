import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
      <AdminLoginForm />
    </AuthFormShell>
  );
}
