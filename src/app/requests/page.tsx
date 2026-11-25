import { redirect } from "next/navigation";

export default function LegacyRequestsRedirectPage() {
  redirect("/orders");
}
