import {
  BookOpen,
  Gift,
  Home,
  Laptop,
  Shirt,
  Sparkles,
  Utensils,
  Wrench,
} from "lucide-react";
import type { Category } from "@/types/marketplace";

interface CategoryIconProps {
  icon: Category["icon"];
  className?: string;
}

export function CategoryIcon({ icon, className = "h-5 w-5" }: CategoryIconProps) {
  switch (icon) {
    case "book":
      return <BookOpen className={className} aria-hidden="true" />;
    case "laptop":
      return <Laptop className={className} aria-hidden="true" />;
    case "utensils":
      return <Utensils className={className} aria-hidden="true" />;
    case "shirt":
      return <Shirt className={className} aria-hidden="true" />;
    case "home":
      return <Home className={className} aria-hidden="true" />;
    case "wrench":
      return <Wrench className={className} aria-hidden="true" />;
    case "gift":
      return <Gift className={className} aria-hidden="true" />;
    case "sparkles":
    default:
      return <Sparkles className={className} aria-hidden="true" />;
  }
}
