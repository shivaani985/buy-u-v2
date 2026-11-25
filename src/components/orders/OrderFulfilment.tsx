import { MapPin } from "lucide-react";
import { ServiceOrderDetailsBlock, type ServiceOrderDetailItem } from "@/components/orders/ServiceOrderDetailsBlock";
import { OrderSection } from "@/components/orders/OrderDisplay";
import { formatMytDateTime } from "@/lib/financials/policy";

export function OrderFulfilment({ id, area, service, items }: {
  id: string; area: string; service: boolean;
  items: Array<ServiceOrderDetailItem & { pickupNote: string | null; pickupWindowStart: string | null }>;
}) {
  const showLocation = !service || items.some((item) => item.serviceMode === "both" || item.serviceMode === "in_person");
  return (
    <OrderSection title={service ? "Service details" : "Campus collection"}>
      {showLocation && <p className="flex items-start gap-2 text-sm font-semibold">
        <MapPin className="mt-0.5 size-4 shrink-0 text-brand-purple" aria-hidden="true" />{area}
      </p>}
      {service ? <ServiceOrderDetailsBlock orderId={id} items={items} compact /> :
        items.filter((item) => item.pickupNote || item.pickupWindowStart).map((item) => (
          <div key={item.id} className="mt-3 border-t border-border-crisp pt-2 text-sm text-ink-secondary">
            <p className="font-bold text-ink-primary">{item.title}</p>
            {item.pickupWindowStart && <p>Collection from {formatMytDateTime(item.pickupWindowStart)}</p>}
            {item.pickupNote && <p className="whitespace-pre-wrap break-words">{item.pickupNote}</p>}
          </div>
        ))}
    </OrderSection>
  );
}
