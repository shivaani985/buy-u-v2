"use client";

import { useState } from "react";

interface ListingImageProps {
  src: string | null;
  alt: string;
  fallback: React.ReactNode;
}

/**
 * Renders public Supabase Storage photos and degrades cleanly to the
 * editorial fallback frame if a path is invalid or unavailable.
 */
export function ListingImage({ src, alt, fallback }: ListingImageProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return <>{fallback}</>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  );
}
