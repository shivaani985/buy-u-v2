import { redirect } from "next/navigation";

export default function LegacySellerServicesRedirectPage() {
  redirect("/seller/orders");
}
