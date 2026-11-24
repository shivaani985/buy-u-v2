"use client";

/**
 * Zero-dependency responsive SVG & CSS charts in Buy-U Campus Pop palette.
 */

export function TrendLineChart({
  points,
  valueFormatter,
  emptyLabel = "No activity recorded in this period.",
}: {
  points: Array<{ label: string; value: number }>;
  valueFormatter: (v: number) => string;
  emptyLabel?: string;
}) {
  if (points.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[#DFDCE8] bg-[#FAF9FC] py-8 text-center text-xs text-[#6B6779]">
        {emptyLabel}
      </p>
    );
  }
  const max = Math.max(1, ...points.map((p) => p.value));
  const w = 520;
  const h = 150;
  const pad = 16;
  const coords = points.map((p, i) => {
    const x =
      points.length === 1
        ? w / 2
        : pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - (p.value / max) * (h - pad * 2);
    return { x, y, ...p };
  });
  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-40 w-full overflow-visible"
        role="img"
        aria-label="Trend line chart"
      >
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#ECEAF3" strokeWidth="1" />
        <polyline
          fill="none"
          stroke="#4E2A84"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polyline}
        />
        {coords.map((c) => (
          <circle key={c.label} cx={c.x} cy={c.y} r="3.5" fill="#008285">
            <title>{`${c.label}: ${valueFormatter(c.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex items-center justify-between text-[10.5px] text-[#6B6779]">
        <span>{points[0]?.label}</span>
        <span>Peak: {valueFormatter(max)}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export function HorizontalBarList({
  items,
  valueFormatter,
  emptyLabel = "No data available.",
}: {
  items: Array<{ label: string; value: number; color?: string }>;
  valueFormatter: (v: number) => string;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="py-4 text-center text-xs text-[#6B6779]">{emptyLabel}</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const pct = Math.max(4, Math.round((item.value / max) * 100));
        return (
          <div key={item.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="truncate font-semibold text-[#14121A]">{item.label}</span>
              <span className="font-bold text-[#4E2A84]">{valueFormatter(item.value)}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[#F1EFF6]">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: item.color ?? "#4E2A84" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SimpleDonutBreakdown({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const radius = 38;
  const circ = 2 * Math.PI * radius;
  const arcs = segments.reduce<
    Array<{ label: string; value: number; color: string; dash: number; offset: number }>
  >((acc, seg) => {
    const prevUsed = acc.reduce((sum, item) => sum + item.dash, 0);
    const dash = total > 0 ? (Math.max(0, seg.value) / total) * circ : 0;
    acc.push({ ...seg, dash, offset: -prevUsed });
    return acc;
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0" role="img" aria-label="Distribution donut chart">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#F1EFF6" strokeWidth="14" />
        {total > 0
          ? arcs.map((a) => (
              <circle
                key={a.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={a.color}
                strokeWidth="14"
                strokeDasharray={`${a.dash} ${circ}`}
                strokeDashoffset={a.offset}
                transform="rotate(-90 50 50)"
              />
            ))
          : null}
        <text x="50" y="54" textAnchor="middle" className="fill-[#14121A] text-sm font-extrabold">
          {total}
        </text>
      </svg>
      <ul className="space-y-1.5 text-xs">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="font-semibold text-[#4A4656]">{s.label}:</span>
            <span className="font-extrabold text-[#14121A]">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
