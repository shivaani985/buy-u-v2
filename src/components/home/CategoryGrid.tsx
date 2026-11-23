import Link from "next/link";
import { Gift, LayoutGrid, LogIn } from "lucide-react";
import { CategoryIcon } from "@/components/shared/CategoryIcon";
import type { CatalogDataSource, Category } from "@/types/marketplace";

interface CategoryGridProps {
  categories: Category[];
  source: CatalogDataSource;
  useDemo?: boolean;
}

const TILE_STYLES: Record<
  Category["accent"],
  { bg: string; iconBg: string; text: string; border: string }
> = {
  purple: {
    bg: "bg-[#F8F6FD] hover:bg-[#F1EDFB]",
    border: "border-[#ECE7F6]",
    iconBg: "bg-white text-[#4E2A84]",
    text: "text-[#4E2A84]",
  },
  teal: {
    bg: "bg-[#F2FAFA] hover:bg-[#E7F6F6]",
    border: "border-[#DDF2F2]",
    iconBg: "bg-white text-[#008386]",
    text: "text-[#008386]",
  },
  blue: {
    bg: "bg-[#F2F7FC] hover:bg-[#E7F0FA]",
    border: "border-[#DEECF8]",
    iconBg: "bg-white text-[#1D70B8]",
    text: "text-[#1D70B8]",
  },
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
              className="text-[19px] font-extrabold italic leading-[1.12] tracking-[-0.02em] text-[#111018] sm:text-[21px]"
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
            className="hidden h-14 w-px bg-[#D7D4E2] md:block"
            aria-hidden="true"
          />
        </div>

        {/* Right Compact Rounded-Square Tiles (Scrollable Strip with Smooth Feedback) */}
        <div className="min-w-0 flex-1">
          {categories.length > 0 ? (
            <div
              role="list"
              aria-label="Campus marketplace categories"
              className="flex items-center gap-2.5 overflow-x-auto pb-1.5 pt-0.5 no-scrollbar sm:gap-3"
            >
              {categories.map((category) => {
                const style =
                  TILE_STYLES[category.accent] ?? TILE_STYLES.purple;
                return (
                  <Link
                    key={category.id}
                    role="listitem"
                    href={`/marketplace?category=${encodeURIComponent(category.slug)}${demoParam}`}
                    className={`group flex h-[90px] w-[92px] shrink-0 flex-col items-center justify-center rounded-2xl border ${style.border} ${style.bg} p-2 text-center shadow-[0_1px_3px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(20,18,26,0.08)] press-feedback sm:h-[94px] sm:w-[96px]`}
                  >
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-xl shadow-xs ${style.iconBg}`}
                    >
                      <CategoryIcon
                        icon={category.icon}
                        className="h-5 w-5"
                      />
                    </div>
                    <span className="mt-1.5 line-clamp-2 w-full text-[11px] font-bold leading-tight text-[#14121A] group-hover:text-[#4E2A84]">
                      {category.name}
                    </span>
                  </Link>
                );
              })}

              {/* Direct Free Items tile */}
              <Link
                role="listitem"
                href={`/marketplace?type=free${demoParam}`}
                className="group flex h-[90px] w-[92px] shrink-0 flex-col items-center justify-center rounded-2xl border border-[#DDF2F2] bg-[#F2FAFA] p-2 text-center shadow-[0_1px_3px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-0.5 hover:bg-[#E7F6F6] hover:shadow-[0_4px_12px_rgba(20,18,26,0.08)] press-feedback sm:h-[94px] sm:w-[96px]"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#008386] shadow-xs">
                  <Gift className="h-5 w-5" aria-hidden="true" />
                </div>
                <span className="mt-1.5 line-clamp-2 w-full text-[11px] font-bold leading-tight text-[#14121A] group-hover:text-[#008386]">
                  Free Items
                </span>
              </Link>

              {/* All Categories tile */}
              <Link
                role="listitem"
                href={`/marketplace${demoOnly}`}
                className="group flex h-[90px] w-[92px] shrink-0 flex-col items-center justify-center rounded-2xl border border-[#ECE7F6] bg-[#F8F6FD] p-2 text-center shadow-[0_1px_3px_rgba(20,18,26,0.04)] transition-all hover:-translate-y-0.5 hover:bg-[#F1EDFB] hover:shadow-[0_4px_12px_rgba(20,18,26,0.08)] press-feedback sm:h-[94px] sm:w-[96px]"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#4E2A84] shadow-xs">
                  <LayoutGrid className="h-5 w-5" aria-hidden="true" />
                </div>
                <span className="mt-1.5 line-clamp-2 w-full text-[11px] font-bold leading-tight text-[#4E2A84]">
                  All Categories
                </span>
              </Link>
            </div>
          ) : source === "auth_required" ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <Link
                href="/marketplace"
                className="group flex h-[90px] w-[92px] shrink-0 flex-col items-center justify-center rounded-2xl border border-[#ECE7F6] bg-[#F8F6FD] p-2 text-center shadow-xs hover:border-[#4E2A84]"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#4E2A84] shadow-xs">
                  <LayoutGrid className="h-5 w-5" aria-hidden="true" />
                </div>
                <span className="mt-1.5 text-[11px] font-bold text-[#14121A]">
                  Marketplace
                </span>
              </Link>
              <Link
                href="/marketplace?type=service"
                className="group flex h-[90px] w-[92px] shrink-0 flex-col items-center justify-center rounded-2xl border border-[#DEECF8] bg-[#F2F7FC] p-2 text-center shadow-xs hover:border-[#1D70B8]"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#1D70B8] shadow-xs">
                  <CategoryIcon icon="wrench" className="h-5 w-5" />
                </div>
                <span className="mt-1.5 text-[11px] font-bold text-[#14121A]">
                  Services
                </span>
              </Link>
              <Link
                href="/marketplace?type=free"
                className="group flex h-[90px] w-[92px] shrink-0 flex-col items-center justify-center rounded-2xl border border-[#DDF2F2] bg-[#F2FAFA] p-2 text-center shadow-xs hover:border-[#008386]"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[#008386] shadow-xs">
                  <Gift className="h-5 w-5" aria-hidden="true" />
                </div>
                <span className="mt-1.5 text-[11px] font-bold text-[#14121A]">
                  Free Items
                </span>
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl border border-[#4E2A84]/35 bg-[#F7F3FC] px-4 py-3 text-[13px] font-bold text-[#4E2A84] hover:bg-[#4E2A84] hover:text-white press-feedback"
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
