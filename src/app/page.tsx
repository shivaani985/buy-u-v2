import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CategoryGrid } from "@/components/home/CategoryGrid";
import { EditorialHero } from "@/components/home/EditorialHero";
import { ListingCard } from "@/components/marketplace/ListingCard";
import { DataSourceBanner } from "@/components/shared/DataSourceBanner";
import { getCategories, getListings } from "@/lib/catalog";

interface HomePageProps {
  searchParams: Promise<{ demo?: string }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const useDemo = params.demo === "1";

  const [categoriesResult, listingsResult] = await Promise.all([
    getCategories({ useDemo }),
    getListings({ useDemo }),
  ]);

  const demoSuffix = useDemo ? "?demo=1" : "";
  const latestCampusItems = listingsResult.data
    .filter(
      (item) => item.listingType !== "service" && item.listingType !== "free"
    )
    .slice(0, 4);

  const studentServices = listingsResult.data
    .filter((item) => item.listingType === "service")
    .slice(0, 3);

  const freeItems = listingsResult.data
    .filter((item) => item.listingType === "free")
    .slice(0, 3);

  return (
    <div>
      {/* 1–3. Editorial Hero + Browse Marketplace CTA + Sell an Item CTA */}
      <EditorialHero />

      {/* Explicit Data Source / RLS Status */}
      <div className="mx-auto w-full max-w-[1680px] px-4 pt-6 sm:px-6 lg:px-10 xl:px-14">
        <DataSourceBanner
          source={listingsResult.source}
          notice={listingsResult.notice}
          errorCode={listingsResult.errorCode}
          demoHref="/?demo=1"
          liveHref="/"
        />
      </div>

      {/* 4. Explore by Category */}
      <section
        aria-labelledby="categories-heading"
        className="mx-auto w-full max-w-[1680px] px-4 pt-12 sm:px-6 lg:px-10 xl:px-14"
      >
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#14121A] pb-3">
          <h2
            id="categories-heading"
            className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl"
          >
            Explore by{" "}
            <span className="font-editorial italic font-bold text-[#4E2A84]">
              Category
            </span>
          </h2>
          <Link
            href={`/marketplace${demoSuffix}`}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-[#1D70B8] hover:text-[#4E2A84] underline-offset-4 hover:underline"
          >
            <span>View full catalog</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {categoriesResult.data.length > 0 ? (
          <CategoryGrid categories={categoriesResult.data} />
        ) : (
          <p className="border border-[#D9D6E2] bg-[#F7F7F5] p-6 text-sm text-[#4A4656]">
            {categoriesResult.source === "auth_required"
              ? "Sign in with your UMS student or staff email above to explore live UMSKAL categories, or choose Demo Preview."
              : categoriesResult.source === "restricted"
                ? "Verify or activate your UMS account to view live categories."
                : "No active marketplace categories found."}
          </p>
        )}
      </section>

      {/* 5. Latest on Campus */}
      <section
        aria-labelledby="latest-heading"
        className="mx-auto w-full max-w-[1680px] px-4 pt-16 sm:px-6 lg:px-10 xl:px-14"
      >
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#14121A] pb-3">
          <h2
            id="latest-heading"
            className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl"
          >
            Latest on{" "}
            <span className="font-editorial italic font-bold text-[#1D70B8]">
              Campus
            </span>
          </h2>
          <Link
            href={`/marketplace${demoSuffix}`}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-[#4E2A84] hover:text-[#1D70B8] underline-offset-4 hover:underline"
          >
            <span>Browse all items</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {latestCampusItems.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {latestCampusItems.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <p className="border border-[#D9D6E2] bg-[#F7F7F5] p-6 text-sm text-[#4A4656]">
            {listingsResult.source === "auth_required"
              ? "Sign in with your UMS email to view live campus listings."
              : "No published campus product listings found yet."}
          </p>
        )}
      </section>

      {/* 6. Student Services */}
      <section
        aria-labelledby="services-heading"
        className="mx-auto w-full max-w-[1680px] px-4 pt-16 sm:px-6 lg:px-10 xl:px-14"
      >
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#00A3A6] pb-3">
          <h2
            id="services-heading"
            className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl"
          >
            Student{" "}
            <span className="font-editorial italic font-bold text-[#007D80]">
              Services
            </span>
          </h2>
          <Link
            href={`/marketplace?type=service${useDemo ? "&demo=1" : ""}`}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-[#007D80] hover:text-[#4E2A84] underline-offset-4 hover:underline"
          >
            <span>Explore all services</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {studentServices.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {studentServices.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <p className="border border-[#D9D6E2] bg-[#F7F7F5] p-6 text-sm text-[#4A4656]">
            {listingsResult.source === "error"
              ? "Live student services require authenticated access or public SELECT grants."
              : "No student services listed yet."}
          </p>
        )}
      </section>

      {/* 7. Free Items */}
      <section
        aria-labelledby="free-heading"
        className="mx-auto w-full max-w-[1680px] px-4 pt-16 sm:px-6 lg:px-10 xl:px-14"
      >
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#4E2A84] pb-3">
          <h2
            id="free-heading"
            className="text-2xl font-extrabold tracking-[-0.02em] text-[#14121A] sm:text-3xl"
          >
            Free{" "}
            <span className="font-editorial italic font-bold text-[#4E2A84]">
              Items
            </span>
          </h2>
          <Link
            href={`/marketplace?type=free${useDemo ? "&demo=1" : ""}`}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-[#4E2A84] hover:text-[#1D70B8] underline-offset-4 hover:underline"
          >
            <span>See all giveaways</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        {freeItems.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {freeItems.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <p className="border border-[#D9D6E2] bg-[#F7F7F5] p-6 text-sm text-[#4A4656]">
            {listingsResult.source === "error"
              ? "Live free notices require authenticated access or public SELECT grants."
              : "No free items available right now."}
          </p>
        )}
      </section>
    </div>
  );
}
