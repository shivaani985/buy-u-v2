import { redirect } from "next/navigation";

interface LegacyListingRedirectProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ demo?: string }>;
}

/**
 * Compatibility route so `/listing/[id]` resolves cleanly to canonical `/listings/[slug]`.
 */
export default async function LegacyListingRedirect({
  params,
  searchParams,
}: LegacyListingRedirectProps) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const query = sp.demo === "1" ? "?demo=1" : "";
  redirect(`/listings/${encodeURIComponent(id)}${query}`);
}
