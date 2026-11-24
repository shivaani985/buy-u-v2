import type { Metadata } from "next";
import Link from "next/link";
import {
  NotificationsClient,
  type NotificationItem,
} from "@/components/notifications/NotificationsClient";
import {
  createSupabaseServerClient,
  getSessionSummary,
} from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Your Buy-U orders, services, donations, reviews, and financial alerts.",
};

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.profile?.id) {
    return (
      <div className="mx-auto max-w-lg px-4 py-12 text-center">
        <h1 className="text-xl font-extrabold text-[#14121A]">Sign in required</h1>
        <Link href="/login?next=/notifications" className="mt-4 inline-block rounded-xl bg-[#4E2A84] px-4 py-2 text-xs font-bold text-white">
          Sign In
        </Link>
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  let items: NotificationItem[] = [];
  if (supabase) {
    const { data } = await supabase
      .from("notifications")
      .select("id,kind,title,body,href,read_at,created_at")
      .eq("user_id", session.profile.id)
      .order("created_at", { ascending: false })
      .limit(80);
    items = ((data ?? []) as Array<{
      id: string;
      kind: string;
      title: string;
      body: string;
      href: string | null;
      read_at: string | null;
      created_at: string;
    }>).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      href: r.href,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
  }

  return (
    <div className="mx-auto w-full max-w-[960px] space-y-6 px-4 py-6 sm:px-6 lg:px-10">
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl">
          Notifications
        </h1>
        <p className="mt-1 text-sm text-[#6B6779]">
          Orders, disputes, refunds, withdrawals, service requests, free items, and moderation alerts.
        </p>
      </div>
      <NotificationsClient items={items} />
    </div>
  );
}
