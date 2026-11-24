"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { markNotificationsReadAction } from "@/app/marketplace-actions";
import { formatRelativeTime } from "@/lib/format";

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationsClient({ items }: { items: NotificationItem[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [busy, setBusy] = useState(false);

  const unreadCount = items.filter((n) => !n.readAt).length;
  const shown = filter === "unread" ? items.filter((n) => !n.readAt) : items;

  async function markOne(id: string) {
    setBusy(true);
    await markNotificationsReadAction(id);
    setBusy(false);
    router.refresh();
  }

  async function markAll() {
    setBusy(true);
    await markNotificationsReadAction(null);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6E3EE] bg-white p-3.5">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded-xl px-3.5 py-1.5 text-xs font-bold ${
              filter === "all" ? "bg-[#4E2A84] text-white" : "border border-[#E6E3EE] text-[#4A4656]"
            }`}
          >
            All ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter("unread")}
            className={`rounded-xl px-3.5 py-1.5 text-xs font-bold ${
              filter === "unread" ? "bg-[#008285] text-white" : "border border-[#E6E3EE] text-[#4A4656]"
            }`}
          >
            Unread ({unreadCount})
          </button>
        </div>

        <button
          type="button"
          disabled={busy || unreadCount === 0}
          onClick={markAll}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#4E2A84] px-3.5 py-1.5 text-xs font-bold text-[#4E2A84] hover:bg-[#F3EEFA] disabled:opacity-50"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          <span>Mark All Read</span>
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-[#E6E3EE] bg-white p-10 text-center">
          <Bell className="mx-auto h-7 w-7 text-[#8B869B]" />
          <p className="mt-2 text-sm font-bold text-[#14121A]">All caught up</p>
          <p className="mt-1 text-xs text-[#6B6779]">No notifications in this view.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {shown.map((n) => (
            <div
              key={n.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 text-xs ${
                n.readAt ? "border-[#E6E3EE] bg-white" : "border-[#C9B6E4] bg-[#F7F3FD]"
              }`}
            >
              <div className="space-y-0.5">
                <p className="font-extrabold text-[#14121A]">{n.title}</p>
                <p className="text-[#4A4656]">{n.body}</p>
                <p className="text-[10.5px] text-[#8B869B]">{formatRelativeTime(n.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {n.href && n.href.startsWith("/") ? (
                  <Link
                    href={n.href}
                    className="rounded-xl bg-[#4E2A84] px-3 py-1.5 text-xs font-bold text-white"
                  >
                    View
                  </Link>
                ) : null}
                {!n.readAt ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => markOne(n.id)}
                    className="rounded-xl border border-[#E6E3EE] bg-white px-3 py-1.5 text-xs font-bold text-[#4A4656]"
                  >
                    Mark Read
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
