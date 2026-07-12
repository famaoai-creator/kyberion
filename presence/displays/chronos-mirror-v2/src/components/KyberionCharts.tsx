import React from 'react';

/**
 * KyberionCharts — self-contained SVG charts for the Chronos dashboard.
 *
 * No external charting library, no CDN, CSP-safe (inline SVG + inline style only).
 * All props are plain values/arrays (numbers stay numbers) so A2UI sanitizeProps
 * passes them through untouched. Colors derive from the Kyberion design tokens
 * (--kb-*) plus a small status palette, to stay consistent with DS-01.
 */

// --- Design-system-aligned series palette ---
// Primary/warning come from --kb-* tokens; status hues match the app's de-facto
// Tailwind status classes (emerald=ok, amber=busy, rose=error, violet=secondary).
export const KB_SERIES = {
  accent: 'var(--kb-accent, #00F2FF)',
  warning: 'var(--kb-warning, #FFAB00)',
  ok: '#34D399', // emerald-400
  ready: '#34D399',
  done: '#34D399',
  busy: '#FBBF24', // amber-400
  attention: '#FBBF24',
  inProgress: '#00F2FF',
  review: '#A78BFA', // violet-400
  blocked: '#FB7185', // rose-400
  error: '#FB7185',
  backlog: '#64748B', // slate-500
  pending: '#64748B',
  archived: '#475569',
  muted: 'var(--kb-text-secondary, #94A3B8)',
} as const;

export type ChartDatum = { label: string; value: number; color?: string };

function colorFor(label: string, explicit?: string, index = 0): string {
  if (explicit) return explicit;
  const key = label.toLowerCase().replace(/[^a-z]/g, '');
  const map: Record<string, string> = {
    ready: KB_SERIES.ready,
    ok: KB_SERIES.ok,
    done: KB_SERIES.done,
    healthy: KB_SERIES.ok,
    busy: KB_SERIES.busy,
    attention: KB_SERIES.attention,
    inprogress: KB_SERIES.inProgress,
    running: KB_SERIES.inProgress,
    review: KB_SERIES.review,
    blocked: KB_SERIES.blocked,
    error: KB_SERIES.error,
    failed: KB_SERIES.error,
    backlog: KB_SERIES.backlog,
    pending: KB_SERIES.pending,
    planned: KB_SERIES.pending,
    archived: KB_SERIES.archived,
  };
  if (map[key]) return map[key];
  const cycle = [
    KB_SERIES.accent,
    KB_SERIES.ready,
    KB_SERIES.busy,
    KB_SERIES.review,
    KB_SERIES.blocked,
    KB_SERIES.warning,
  ];
  return cycle[index % cycle.length];
}

const label10 = 'text-[10px] uppercase tracking-widest opacity-60 text-slate-300/80';

// --- display:donut — status distribution as a ring with center total ---
export const KyberionDonut = ({
  title,
  titleKey: _titleKey,
  data = [],
  centerLabel,
  size = 132,
}: {
  title?: string;
  titleKey?: string;
  data?: ChartDatum[];
  centerLabel?: string;
  size?: number;
}) => {
  const items = (data || []).filter((d) => Number(d.value) > 0);
  const total = items.reduce((s, d) => s + Number(d.value), 0);
  const stroke = 14;
  const r = (size - stroke) / 2;
  const cx = size / 2,
    cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && <div className={label10}>{title}</div>}
      <div className="flex items-center gap-5">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={title || 'distribution'}
        >
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="rgba(148,163,184,0.12)"
            strokeWidth={stroke}
          />
          {total > 0 &&
            items.map((d, i) => {
              const frac = Number(d.value) / total;
              const len = frac * circ;
              const seg = (
                <circle
                  key={i}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={colorFor(d.label, d.color, i)}
                  strokeWidth={stroke}
                  strokeDasharray={`${len} ${circ - len}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${cx} ${cy})`}
                  strokeLinecap="butt"
                />
              );
              offset += len;
              return seg;
            })}
          <text
            x={cx}
            y={cy - 2}
            textAnchor="middle"
            fontSize="22"
            fontWeight="700"
            fill="var(--kb-text-primary, #F8FAFC)"
          >
            {total}
          </text>
          <text
            x={cx}
            y={cy + 16}
            textAnchor="middle"
            fontSize="8"
            letterSpacing="1.5"
            fill="var(--kb-text-secondary, #94A3B8)"
          >
            {(centerLabel || 'TOTAL').toUpperCase()}
          </text>
        </svg>
        <div className="flex flex-col gap-1.5">
          {items.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ background: colorFor(d.label, d.color, i) }}
              />
              <span className="opacity-70">{d.label}</span>
              <span className="opacity-100 font-mono ml-auto pl-3">{d.value}</span>
            </div>
          ))}
          {total === 0 && <div className="text-[10px] opacity-40 italic">no data</div>}
        </div>
      </div>
    </div>
  );
};

// --- display:bar-chart — horizontal category bars ---
export const KyberionBarChart = ({
  title,
  data = [],
  unit = '',
}: {
  title?: string;
  titleKey?: string;
  data?: ChartDatum[];
  unit?: string;
}) => {
  const items = data || [];
  const max = Math.max(1, ...items.map((d) => Number(d.value)));
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && <div className={label10}>{title}</div>}
      <div className="flex flex-col gap-2">
        {items.length === 0 && <div className="text-[10px] opacity-40 italic">no data</div>}
        {items.map((d, i) => {
          const pct = Math.round((Number(d.value) / max) * 100);
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex justify-between text-[10px]">
                <span className="opacity-70 truncate max-w-[70%]">{d.label}</span>
                <span className="font-mono opacity-90">
                  {d.value}
                  {unit}
                </span>
              </div>
              <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden border border-white/10">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${pct}%`, background: colorFor(d.label, d.color, i) }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- display:stacked-bar — one horizontal bar split into status buckets ---
export const KyberionStackedBar = ({
  title,
  data = [],
  showLegend = true,
}: {
  title?: string;
  titleKey?: string;
  data?: ChartDatum[];
  showLegend?: boolean;
}) => {
  const items = (data || []).filter((d) => Number(d.value) > 0);
  const total = items.reduce((s, d) => s + Number(d.value), 0);
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && <div className={label10}>{title}</div>}
      <div className="h-3 w-full flex rounded-full overflow-hidden border border-white/10 bg-white/5">
        {total === 0 && <div className="w-full" />}
        {items.map((d, i) => (
          <div
            key={i}
            title={`${d.label}: ${d.value}`}
            style={{
              width: `${(Number(d.value) / total) * 100}%`,
              background: colorFor(d.label, d.color, i),
            }}
            className="h-full transition-all duration-700"
          />
        ))}
      </div>
      {showLegend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {items.map((d, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px]">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ background: colorFor(d.label, d.color, i) }}
              />
              <span className="opacity-70">{d.label}</span>
              <span className="font-mono opacity-90">{d.value}</span>
            </div>
          ))}
          {total === 0 && <div className="text-[10px] opacity-40 italic">no data</div>}
        </div>
      )}
    </div>
  );
};

// --- display:sparkline — compact time-series line ---
export const KyberionSparkline = ({
  title,
  points = [],
  color,
  unit = '',
  width = 240,
  height = 48,
}: {
  title?: string;
  titleKey?: string;
  points?: number[];
  color?: string;
  unit?: string;
  width?: number;
  height?: number;
}) => {
  const pts = (points || []).map(Number).filter((n) => !Number.isNaN(n));
  const stroke = color || KB_SERIES.accent;
  const max = Math.max(1, ...pts);
  const min = Math.min(0, ...pts);
  const range = max - min || 1;
  const stepX = pts.length > 1 ? width / (pts.length - 1) : width;
  const coords = pts.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts.length ? pts[pts.length - 1] : 0;
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex justify-between items-baseline">
        {title && <div className={label10}>{title}</div>}
        <span className="font-mono text-[11px]" style={{ color: stroke }}>
          {last}
          {unit}
        </span>
      </div>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={title || 'trend'}
      >
        {pts.length > 1 && (
          <>
            <polyline
              points={coords.join(' ')}
              fill="none"
              stroke={stroke}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <polyline
              points={`0,${height} ${coords.join(' ')} ${width},${height}`}
              fill={stroke}
              opacity="0.08"
              stroke="none"
            />
          </>
        )}
        {pts.length <= 1 && (
          <text x="4" y={height / 2} fontSize="9" fill="var(--kb-text-secondary,#94A3B8)">
            no data
          </text>
        )}
      </svg>
    </div>
  );
};
