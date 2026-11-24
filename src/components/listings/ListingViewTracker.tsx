"use client";

import { useEffect, useRef } from "react";
import { recordListingViewAction } from "@/app/marketplace-actions";

/**
 * Records a single deduplicated daily listing view (and updates member last_active_at)
 * via server-validated RPC when an authenticated member opens a live listing page.
 */
export function ListingViewTracker({ listingId }: { listingId: string }) {
  const sentForId = useRef<string | null>(null);

  useEffect(() => {
    if (!listingId || sentForId.current === listingId) return;
    sentForId.current = listingId;
    void recordListingViewAction(listingId).catch(() => {
      // Non-blocking telemetry; never disrupt listing display.
    });
  }, [listingId]);

  return null;
}
