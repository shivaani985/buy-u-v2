"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Rebase the countdown on the server time when the route loads or refreshes. */
export function useOrderClock(serverNow: number, intervalMs = 1000) {
  const [tick, setTick] = useState({ serverNow, elapsed: 0 });
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setTick({ serverNow, elapsed: performance.now() - start }), intervalMs);
    return () => window.clearInterval(timer);
  }, [serverNow, intervalMs]);
  return serverNow + (tick.serverNow === serverNow ? tick.elapsed : 0);
}

/** Keep an open orders view current across buyer and seller sessions. */
export function useOrderRefresh(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [active, router]);
}
