"use server";

import { revalidatePath } from "next/cache";
import { evaluateSellerEligibility } from "@/lib/seller/validation";
import { createSupabaseServerClient, getSessionSummary } from "@/lib/supabase/server";
import { isValidUuid } from "@/lib/buyer/validation";
import { validateNoticeboardPost, type FreeNoticeInput } from "@/lib/marketplace/free-noticeboard";

export async function writeFreePostAction(input: {
  id: string; action: "publish" | "edit"; post: FreeNoticeInput;
} | {
  id: string; action: "remove" | "renew"; acknowledged?: boolean;
}) {
  if (!isValidUuid(input.id)) return { ok: false, message: "Invalid free item reference." };
  const session = await getSessionSummary();
  if (!evaluateSellerEligibility(session).eligible) {
    return { ok: false, message: "An eligible UMS student account is required." };
  }

  const post = "post" in input ? input.post : null;
  if (post) {
    const error = validateNoticeboardPost(post);
    if (error) return { ok: false, message: error };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, message: "The noticeboard is temporarily unavailable." };

  const { error } = await supabase.rpc("write_free_noticeboard_post", {
    p_id: input.id, p_action: input.action,
    p_title: post?.title ?? null, p_description: post?.description ?? null,
    p_pickup_location: post?.pickupLocation ?? null, p_image_paths: post?.imagePaths ?? null,
    p_acknowledged: "acknowledged" in input && input.acknowledged === true,
  });
  if (error) {
    if (error.message.includes("PROFILE_REQUIRED")) return { ok: false, message: "Complete your student profile before publishing." };
    if (error.message.includes("NOT_RENEWABLE")) return { ok: false, message: "This post is no longer eligible for renewal." };
    if (error.message.includes("CONFIRM_AVAILABILITY")) return { ok: false, message: "Confirm that the items are still available." };
    if (error.message.includes("INVALID_PHOTOS")) return { ok: false, message: "One or more uploaded photos could not be verified." };
    if (error.code === "42501") return { ok: false, message: "You cannot change this free item post." };
    return { ok: false, message: "Could not save this free item post. Refresh and try again." };
  }

  revalidatePath("/free-items");
  revalidatePath("/");
  revalidatePath("/marketplace");
  const message = { publish: "Free item published.", edit: "Post updated.", remove: "Post removed.", renew: "Post renewed for 3 days." };
  return { ok: true, message: message[input.action] };
}
