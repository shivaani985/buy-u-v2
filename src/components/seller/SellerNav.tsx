"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  LayoutDashboard,
  PlusCircle,
  ShieldAlert,
  Store,
} from "lucide-react";

const TABS = [
  { href: "/seller", label: "Seller Hub", icon: LayoutDashboard },
  { href: "/seller/orders", label: "Orders", icon: ClipboardList },
  { href: "/seller/disputes", label: "Disputes", icon: ShieldAlert },
  { href: "/seller/storefront", label: "Storefront", icon: Store },
  { href: "/sell", label: "Create Listing", icon: PlusCircle },
];

export function SellerNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Seller workspace navigation"
      className="flex flex-wrap items-center gap-2 border-b border-[#E6E3EE] pb-3.5"
    >
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[13.5px] font-bold transition-colors press-feedback ${
              isActive
                ? "bg-[#4E2A84] text-white shadow-[0_2px_6px_rgba(78,42,132,0.2)]"
                : "border border-[#E6E3EE] bg-white text-[#14121A] hover:border-[#4E2A84]/50 hover:bg-[#F8F6FD] hover:text-[#4E2A84]"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
