"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { toggleFavouriteAction } from "@/app/listings/actions";

interface FavouriteButtonProps {
  listingId: string;
  initialFavourited?: boolean;
  canFavourite?: boolean;
  isDemo?: boolean;
  className?: string;
}

export function FavouriteButton({
  listingId,
  initialFavourited = false,
  canFavourite = false,
  isDemo = false,
  className = "",
}: FavouriteButtonProps) {
  const router = useRouter();
  const [favourited, setFavourited] = useState(initialFavourited);
  const [burstKey, setBurstKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  function handleToggle(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();

    if (!canFavourite && !isDemo) {
      router.push("/login?next=/");
      return;
    }

    const nextState = !favourited;
    setFavourited(nextState);
    if (nextState) {
      setBurstKey((k) => k + 1);
    }

    if (isDemo) return;

    startTransition(async () => {
      const res = await toggleFavouriteAction(listingId);
      if (!res.ok) {
        setFavourited(!nextState);
        if (res.error?.toLowerCase().includes("sign in")) {
          router.push("/login?next=/");
        }
        return;
      }
      if (typeof res.isFavourited === "boolean") {
        setFavourited(res.isFavourited);
      }
    });
  }

  const hasPositionClass =
    className.includes("absolute") ||
    className.includes("fixed") ||
    className.includes("sticky");

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={isPending}
      aria-label={favourited ? "Remove from favourites" : "Add to favourites"}
      aria-pressed={favourited}
      className={`group/fav ${hasPositionClass ? "" : "relative"} flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-transparent transition-transform duration-150 hover:scale-115 active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84] disabled:cursor-wait ${className}`}
    >
      {burstKey > 0 && favourited ? (
        <span
          key={`ring-${burstKey}`}
          className="anim-fav-ring pointer-events-none absolute inset-0.5 rounded-full border-2 border-[#FB7185]"
          aria-hidden="true"
        />
      ) : null}
      <Heart
        key={burstKey > 0 && favourited ? `heart-${burstKey}` : "heart-idle"}
        className={`h-6 w-6 drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)] transition-colors duration-150 ${
          favourited
            ? "anim-fav-pop fill-[#FB7185]/90 text-[#FB7185]"
            : "fill-[#14121A]/35 text-white/85 group-hover/fav:text-[#FDA4AF]"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}
