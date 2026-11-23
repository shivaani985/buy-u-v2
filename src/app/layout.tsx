import type { Metadata } from "next";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { getSessionSummary } from "@/lib/supabase/server";
import "./globals.css";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-plus-jakarta",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Buy-U — UMSKAL Campus Marketplace",
    template: "%s | Buy-U UMSKAL",
  },
  description:
    "A community-based university marketplace for Universiti Malaysia Sabah (UMSKAL, Labuan) students and staff to buy, sell, offer services, and share free items.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSessionSummary();

  return (
    <html lang="en" className={`${plusJakarta.variable} ${fraunces.variable}`}>
      <body className="min-h-screen flex flex-col bg-white text-[#14121A]">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-[#4E2A84] focus:text-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold"
        >
          Skip to main content
        </a>

        <SiteHeader session={session} />

        <main id="main-content" className="flex-1">
          {children}
        </main>

        <SiteFooter dataSource={session.source} />
      </body>
    </html>
  );
}
