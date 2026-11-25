import { Check } from "lucide-react";
import { getOrderTimelineSteps } from "@/lib/orders/lifecycle";

interface OrderTimelineProps {
  status: string;
  createdAt: string;
  paidAt: string | null;
  handedOverAt: string | null;
  completedAt: string | null;
  isService?: boolean;
}

function formatStepTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

export function OrderTimeline({
  status,
  createdAt,
  paidAt,
  handedOverAt,
  completedAt,
  isService = false,
}: OrderTimelineProps) {
  const s = status.toLowerCase();
  if (s === "expired" || s === "cancelled" || s === "canceled" || s === "refunded") {
    return null;
  }

  const steps = getOrderTimelineSteps({
    status,
    createdAt,
    paidAt,
    handedOverAt,
    completedAt,
  });

  return (
    <ol
      aria-label="Order progress"
      className="grid grid-cols-2 gap-2 border-t border-[#F1EFF6] bg-[#FCFBFE] px-5 py-3 sm:grid-cols-4"
    >
      {steps.map((step, idx) => {
        const ts = formatStepTime(step.timestamp);
        return (
          <li key={step.key} className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                step.done
                  ? "bg-[#008285] text-white"
                  : step.active
                    ? "border-2 border-[#4E2A84] bg-white text-[#4E2A84]"
                    : "border border-[#D7D2E5] bg-white text-[#8B869B]"
              }`}
              aria-hidden="true"
            >
              {step.done ? <Check className="h-3 w-3" /> : idx + 1}
            </span>
            <div className="min-w-0">
              <p
                className={`text-[11.5px] font-bold leading-tight ${
                  step.done
                    ? "text-[#14121A]"
                    : step.active
                      ? "text-[#4E2A84]"
                      : "text-[#8B869B]"
                }`}
              >
                {isService && step.key === "handed_over"
                  ? "Service Delivered"
                  : step.label}
              </p>
              {ts ? (
                <p className="mt-0.5 truncate text-[10.5px] text-[#6B6779]">
                  {ts}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
