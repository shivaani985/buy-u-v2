import type { SalesChartPoint } from "@/lib/seller/financials";

interface WeeklySalesChartProps {
  points: SalesChartPoint[];
  available: boolean;
}

export function WeeklySalesChart({ points, available }: WeeklySalesChartProps) {
  const hasSales = points.some((p) => p.amountSen > 0);

  if (!available) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-xl border border-[#ECEAF2] bg-[#FAFAFC] p-4 text-center text-xs text-[#6E6A7C]">
        Weekly sales data is not available yet.
      </div>
    );
  }

  if (!hasSales || points.length === 0) {
    return (
      <div className="flex h-[180px] flex-col items-center justify-center rounded-xl border border-[#ECEAF2] bg-[#FAFAFC] p-4 text-center">
        <p className="text-xs font-bold text-[#14121A]">
          No verified sales in the last 7 days
        </p>
        <p className="mt-1 text-[11.5px] text-[#6E6A7C]">
          Completed and paid campus orders will appear here automatically.
        </p>
      </div>
    );
  }

  const maxRm = Math.max(
    ...points.map((p) => p.amountSen / 100),
    10
  );
  // Round ceiling up to a clean multiple of 10 or 20
  const yStep = maxRm <= 20 ? 5 : maxRm <= 80 ? 20 : Math.ceil(maxRm / 4 / 10) * 10;
  const yMax = Math.max(yStep * 4, Math.ceil(maxRm / yStep) * yStep);
  const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];

  const width = 420;
  const height = 180;
  const padLeft = 36;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const coords = points.map((pt, idx) => {
    const x =
      points.length > 1
        ? padLeft + (idx / (points.length - 1)) * plotW
        : padLeft + plotW / 2;
    const rm = pt.amountSen / 100;
    const y = padTop + plotH - (rm / yMax) * plotH;
    return { x, y, pt, rm };
  });

  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Weekly verified sales in Malaysian Ringgit over the last 7 days"
        className="h-auto w-full overflow-visible"
      >
        {/* Horizontal subtle grid lines */}
        {yTicks.map((tick) => {
          const y = padTop + plotH - (tick / yMax) * plotH;
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#ECEAF2"
                strokeWidth="1"
              />
              <text
                x={padLeft - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="#6E6A7C"
              >
                {Math.round(tick)}
              </text>
            </g>
          );
        })}

        {/* Restrained single purple line series (zero gradient fill) */}
        <polyline
          fill="none"
          stroke="#4E2A84"
          strokeWidth="2.25"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polylinePoints}
        />

        {/* Data points + X-axis day labels */}
        {coords.map(({ x, y, pt, rm }) => (
          <g key={pt.isoDate}>
            <circle
              cx={x}
              cy={y}
              r={rm > 0 ? 4 : 3}
              fill="#FFFFFF"
              stroke="#4E2A84"
              strokeWidth="2"
            >
              <title>{`${pt.label} (${pt.isoDate}): RM ${rm.toFixed(2)}`}</title>
            </circle>
            <text
              x={x}
              y={height - 6}
              textAnchor="middle"
              fontSize="10.5"
              fill="#6E6A7C"
            >
              {pt.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
