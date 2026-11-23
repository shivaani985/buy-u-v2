import {
  BookOpen,
  Dumbbell,
  Gift,
  GraduationCap,
  Home,
  Lamp,
  Laptop,
  Package,
  Palette,
  Printer,
  Shirt,
  Sparkles,
  Utensils,
  Wrench,
} from "lucide-react";

interface CategoryIconProps {
  icon: string;
  className?: string;
}

export function CategoryIcon({ icon, className = "h-5 w-5" }: CategoryIconProps) {
  switch (icon) {
    case "book":
    case "book-open":
      return <BookOpen className={className} aria-hidden="true" />;
    case "laptop":
      return <Laptop className={className} aria-hidden="true" />;
    case "utensils":
      return <Utensils className={className} aria-hidden="true" />;
    case "shirt":
      return <Shirt className={className} aria-hidden="true" />;
    case "lamp":
      return <Lamp className={className} aria-hidden="true" />;
    case "home":
      return <Home className={className} aria-hidden="true" />;
    case "dumbbell":
      return <Dumbbell className={className} aria-hidden="true" />;
    case "graduation-cap":
      return <GraduationCap className={className} aria-hidden="true" />;
    case "palette":
      return <Palette className={className} aria-hidden="true" />;
    case "wrench":
      return <Wrench className={className} aria-hidden="true" />;
    case "printer":
      return <Printer className={className} aria-hidden="true" />;
    case "gift":
      return <Gift className={className} aria-hidden="true" />;
    case "package":
      return <Package className={className} aria-hidden="true" />;
    case "sparkles":
    default:
      return <Sparkles className={className} aria-hidden="true" />;
  }
}
