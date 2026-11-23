import Link from "next/link";
import { Gift, LayoutGrid, LogIn } from "lucide-react";
import { CategoryIcon } from "@/components/shared/CategoryIcon";
import type { CatalogDataSource, Category } from "@/types/marketplace";

interface CategoryGridProps {
  categories: Category[];
  source: CatalogDataSource;
  useDemo?: boolean;
}

const ICON_COLORS: Record<Category["accent"], string> = {
  purple: "text-[#4E2A84]",
  teal: "text-[#008386]",
  blue: "text-[#1D70B8]",
};

export function CategoryGrid({
  categories,
  source,
  useDemo = false,
}: CategoryGridProps) {
  const demoParam = useDemo ? "&demo=1" : "";
  const demoOnly = useDemo ? "?demo=1" : "";

  return (
    <section
      aria-labelledby="categories-heading"
      className="bori-container py-2 lg:py-2.5"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-5">
        {/* Left Title + Teal Underline + Divider */}
        <div className="flex shrink-0 items-center gap-4">
          <div>
            <h2
              id="categories-heading"
              className="text-[20px] font-extrabold italic leading-[1.12] tracking-[-0.02em] text-[#111018] sm:text-[22px]"
            >
              <span className="block">Explore by</span>
              <span className="block">Category</span>
            </h2>
            <span
              className="mt-1.5 block h-[4px] w-14 bg-[#00A3A6]"
              aria-hidden="true"
            />
          </div>
          <span
            className="hidden h-11 w-px bg-[#D7D4E2] md:block"
            aria-hidden="true"
          />
        </div>

        {/* Right Compact Category Tiles (Scrollable Row, Zero Page Overflow) */}
        <div className="min-w-0 flex-1">
          {categories.length > 0 ? (
            <div
              role="list"
              aria-label="Campus marketplace categories"
              className="flex items-center gap-2.5 overflow-x-auto pb-1.5 pt-0.5 no-scrollbar sm:gap-3"
            >
              {categories.map((category) => (
                <Link
                  key={category.id}
                  role="listitem"
                  href={`/marketplace?category=${encodeURIComponent(category.slug)}${demoParam}`}
                  className="group inline-flex shrink-0 items-center gap-2.5 rounded-xl border border-[#E4E1EE] bg-white px-4 py-3 text-[13.5px] font-bold text-[#14121A] shadow-[0_2px_8px_rgba(20,18,26,0.05)] hover:border-[#4E2A84]/50 hover:bg-[#FAF8FD] hover:text-[#4E2A84] press-feedback"
                >
                  <CategoryIcon
                    icon={category.icon}
                    className={`h-5 w-5 shrink-0 ${ICON_COLORS[category.accent]}`}
                  />
                  <span className="whitespace-nowrap">{category.name}</span>
                </Link>
              ))}

              {/* Direct Free Items tile (separate free_notices table in Supabase) */}
              <Link
                role="listitem"
                href={`/marketplace?type=free${demoParam}`}
                className="group inline-flex shrink-0 items-center gap-2.5 rounded-xl border border-[#E4E1EE] bg-white px-4 py-3 text-[13.5px] font-bold text-[#14121A] shadow-[0_2px_8px_rgba(20,18,26,0.05)] hover:border-[#00A3A6] hover:bg-[#F2FAFA] hover:text-[#008386] press-feedback"
              >
                <Gift
                  className="h-5 w-5 shrink-0 text-[#4E2A84]"
                  aria-hidden="true"
                />
                <span className="whitespace-nowrap">Free Items</span>
              </Link>

              <Link
                role="listitem"
                href={`/marketplace${demoOnly}`}
                className="group inline-flex shrink-0 items-center gap-2 rounded-xl border border-[#D5D1E3] bg-[#F7F6FA] px-4 py-3 text-[13.5px] font-bold text-[#4E2A84] hover:border-[#4E2A84] hover:bg-[#EFEAF8] press-feedback"
              >
                <LayoutGrid className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="whitespace-nowrap">All Categories</span>
              </Link>
            </div>
          ) : source === "auth_required" ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 rounded-xl border border-[#E4E1EE] bg-white px-4 py-2.5 text-[13.5px] font-bold text-[#14121A] shadow-[0_2px_8px_rgba(20,18,26,0.05)] hover:border-[#4E2A84]"
              >
                <LayoutGrid className="h-4 w-4 text-[#4E2A84]" aria-hidden="true" />
                <span>Marketplace</span>
              </Link>
              <Link
                href="/marketplace?type=service"
                className="inline-flex items-center gap-2 rounded-xl border border-[#E4E1EE] bg-white px-4 py-2.5 text-[13.5px] font-bold text-[#14121A] shadow-[0_2px_8px_rgba(20,18,26,0.05)] hover:border-[#1D70B8]"
              >
                <CategoryIcon icon="wrench" className="h-4 w-4 text-[#1D70B8]" />
                <span>Student Services</span>
              </Link>
              <Link
                href="/marketplace?type=free"
                className="inline-flex items-center gap-2 rounded-xl border border-[#E4E1EE] bg-white px-4 py-2.5 text-[13.5px] font-bold text-[#14121A] shadow-[0_2px_8px_rgba(20,18,26,0.05)] hover:border-[#00A3A6]"
              >
                <Gift className="h-4 w-4 text-[#008386]" aria-hidden="true" />
                <span>Free Items</span>
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl border border-[#4E2A84]/35 bg-[#F7F3FC] px-4 py-2.5 text-[13.5px] font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                <span>Sign in to view all live categories</span>
              </Link>
            </div>
          ) : (
            <p className="rounded-xl border border-[#E4E1EE] bg-[#F8F7FA] px-4 py-3 text-sm text-[#4A4656]">
              No active categories available right now.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
