"use client";

import { useEffect, useState, type ReactNode } from "react";

/** Drop a discovery card once its server-dated 72-hour window ends. */
export function FreeNoticeVisibility({ expiresAt, snapshotAt, children }: {
  expiresAt: string; snapshotAt: number; children: ReactNode;
}) {
  const [expired, setExpired] = useState(false);
  const remaining = Date.parse(expiresAt) - snapshotAt;

  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [remaining]);

  return expired || remaining <= 0 ? null : children;
}
