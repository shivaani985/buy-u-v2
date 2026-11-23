import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { CategoryIcon } from "@/components/shared/CategoryIcon";
import type { Category } from "@/types/marketplace";

interface CategoryGridProps {
  categories: Category[];
}

const ACCENT_STYLES: Record<Category["accent"], string> = {
  purple: "bg-[#4E2A84] text-white",
  teal: "bg-[#00A3A6] text-[#14121A]",
  blue: "bg-[#1D70B8] text-white",
};

export function CategoryGrid({ categories }: CategoryGridProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {categories.map((category) => (
        <Link
          key={category.id}
          href={`/marketplace?category=${encodeURIComponent(category.slug)}`}
          className="group flex flex-col justify-between border border-[#14121A] bg-white p-5 hover:border-[#4E2A84] hover:bg-[#F7F7F5] press-feedback"
        >
          <div className="flex items-start justify-between gap-3">
            <span
              className={`flex h-11 w-11 items-center justify-center editorial-cut-tr ${ACCENT_STYLES[category.accent]}`}
            >
              <CategoryIcon icon={category.icon} className="h-5 w-5" />
            </span>
            <ArrowUpRight
              className="h-5 w-5 text-[#4A4656] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#4E2A84]"
              aria-hidden="true"
            />
          </div>

          <div className="mt-5">
            <h3 className="text-lg font-extrabold tracking-tight text-[#14121A] group-hover:text-[#4E2A84]">
              {category.name}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-[#4A4656]">
              {category.description}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}
