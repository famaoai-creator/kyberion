import React from 'react';
import { Info, AlertTriangle, CheckCircle, Activity, Clock, ArrowUp, ArrowDown, Minus } from 'lucide-react';

/**
 * A2UI Component Library for Chronos Mirror v2
 */

// --- display:gauge ---
export const KyberionGauge = ({ label, value, unit }: { label: string; value: number; unit: string }) => {
  const percentage = Math.min(100, Math.max(0, value));
  const color = percentage >= 80 ? 'bg-green-500' : percentage >= 50 ? 'bg-kyberion-gold' : 'bg-red-500';
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex justify-between text-[10px] uppercase tracking-widest opacity-60">
        <span>{label}</span>
        <span>{value}{unit}</span>
      </div>
      <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden border border-white/10">
        <div className={`h-full ${color} transition-all duration-1000 ease-out`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
};

// --- display:log ---
export const KyberionLog = ({ title, lines }: { title: string; lines: string[] }) => (
  <div className="flex flex-col gap-3 w-full">
    <div className="text-[10px] uppercase tracking-widest opacity-60 flex items-center gap-2 text-slate-300/80">
      <Info size={12} /> {title}
    </div>
    <div className="bg-slate-950/70 rounded-2xl p-4 font-mono text-[10px] space-y-1 overflow-y-auto max-h-[320px] border border-white/8 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      {lines.map((line, i) => (
        <div key={i} className="opacity-70 border-l border-cyan-200/20 pl-3 leading-5 break-words">{line}</div>
      ))}
    </div>
  </div>
);

// --- display:table ---
export const KyberionTable = ({ title, headers, rows }: { title?: string; headers: string[]; rows: string[][] }) => (
  <div className="flex flex-col gap-3 w-full">
    {title && <div className="text-[10px] uppercase tracking-widest opacity-60 text-slate-300/80">{title}</div>}
    <div className="bg-slate-950/70 rounded-2xl border border-white/8 overflow-hidden overflow-x-auto shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="border-b border-white/10 bg-white/[0.03]">
            {headers.map((h, i) => (
              <th key={i} className="px-4 py-3 text-left uppercase tracking-widest text-slate-400/85 font-bold whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-white/5 hover:bg-white/[0.03] transition">
              {(Array.isArray(row) ? row : Object.values(row)).map((cell: any, ci: number) => (
                <td key={ci} className="px-4 py-3 text-slate-100/75 align-top">{typeof cell === 'object' ? JSON.stringify(cell) : String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

// --- display:status ---
export const KyberionStatus = ({ label, status, detail }: { label: string; status: string; detail?: string }) => {
  const config: Record<string, { icon: React.ReactNode; border: string }> = {
    ok:      { icon: <CheckCircle size={14} className="text-green-500" />,               border: 'border-green-500/20' },
    warning: { icon: <AlertTriangle size={14} className="text-yellow-500" />,             border: 'border-yellow-500/20' },
    error:   { icon: <AlertTriangle size={14} className="text-red-500" />,                border: 'border-red-500/20' },
    pending: { icon: <Activity size={14} className="text-gray-500 animate-pulse" />,      border: 'border-gray-500/20' },
  };
  const c = config[status] || config.pending;
  return (
    <div className={`flex items-center gap-3 p-3 bg-slate-950/55 rounded-xl border ${c.border} shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]`}>
      {c.icon}
      <div className="flex-1">
        <div className="text-[10px] uppercase tracking-widest text-white/78 font-bold">{label}</div>
        {detail && <div className="text-[9px] text-slate-300/45 mt-0.5">{detail}</div>}
      </div>
      <div className="text-[9px] uppercase tracking-widest text-slate-300/45">{status}</div>
    </div>
  );
};

// --- display:kv ---
export const KyberionKeyValue = ({ title, entries }: { title?: string; entries: { key: string; value: string }[] }) => (
  <div className="flex flex-col gap-3 w-full">
    {title && <div className="text-[10px] uppercase tracking-widest opacity-60">{title}</div>}
    <div className="bg-black/40 rounded-xl p-4 border border-white/5 space-y-2">
      {(entries || []).map((entry, i) => (
        <div key={i} className="flex justify-between text-[10px]">
          <span className="opacity-40 uppercase tracking-widest">{entry.key}</span>
          <span className="opacity-70 font-mono">{entry.value}</span>
        </div>
      ))}
    </div>
  </div>
);

// --- display:metric (big number with trend) ---
export const KyberionMetric = ({ label, value, unit, trend, description }: {
  label: string; value: string | number; unit?: string; trend?: 'up' | 'down' | 'flat'; description?: string;
}) => {
  const trendIcon = trend === 'up' ? <ArrowUp size={12} className="text-green-400" />
    : trend === 'down' ? <ArrowDown size={12} className="text-red-400" />
    : <Minus size={12} className="opacity-30" />;
  return (
    <div className="bg-slate-950/60 rounded-2xl p-4 border border-white/8 flex flex-col gap-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="text-[9px] uppercase tracking-widest text-slate-400/85">{label}</div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold font-mono text-white/90">{value}</span>
        {unit && <span className="text-[10px] text-slate-400/70 mb-1">{unit}</span>}
        {trend && <span className="mb-1">{trendIcon}</span>}
      </div>
      {description && <div className="text-[9px] text-slate-300/35 mt-1">{description}</div>}
    </div>
  );
};

// --- display:metrics-row (multiple metrics in a row) ---
export const KyberionMetricsRow = ({ metrics }: {
  metrics: { label: string; value: string | number; unit?: string; trend?: 'up' | 'down' | 'flat' }[];
}) => (
  <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(metrics.length, 4)}, 1fr)` }}>
    {metrics.map((m, i) => <KyberionMetric key={i} {...m} />)}
  </div>
);

// --- display:timeline ---
export const KyberionTimeline = ({ title, events }: {
  title?: string;
  events: { time: string; label: string; status?: string; detail?: string }[];
}) => (
  <div className="flex flex-col gap-3 w-full">
    {title && <div className="text-[10px] uppercase tracking-widest opacity-60 flex items-center gap-2"><Clock size={12} /> {title}</div>}
    <div className="relative pl-6 space-y-4">
      <div className="absolute left-2 top-1 bottom-1 w-px bg-kyberion-gold/20" />
      {events.map((event, i) => {
        const dotColor = event.status === 'error' ? 'bg-red-500' : event.status === 'warning' ? 'bg-yellow-500' : event.status === 'ok' ? 'bg-green-500' : 'bg-kyberion-gold/40';
        return (
          <div key={i} className="relative">
            <div className={`absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full ${dotColor} border-2 border-black`} />
            <div className="text-[9px] font-mono opacity-40">{event.time}</div>
            <div className="text-[10px] opacity-70 font-bold">{event.label}</div>
            {event.detail && <div className="text-[9px] opacity-30 mt-0.5">{event.detail}</div>}
          </div>
        );
      })}
    </div>
  </div>
);

// --- display:progress (multi-step pipeline) ---
export const KyberionProgress = ({ title, steps }: {
  title?: string;
  steps: { label: string; status: 'done' | 'active' | 'pending' }[];
}) => (
  <div className="flex flex-col gap-3 w-full">
    {title && <div className="text-[10px] uppercase tracking-widest opacity-60">{title}</div>}
    <div className="flex items-center gap-1">
      {steps.map((step, i) => {
        const bg = step.status === 'done' ? 'bg-green-500/80' : step.status === 'active' ? 'bg-kyberion-gold/80 animate-pulse' : 'bg-white/10';
        const textColor = step.status === 'pending' ? 'opacity-30' : 'opacity-80';
        return (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center gap-1 flex-1">
              <div className={`w-full h-2 rounded-full ${bg} transition-all duration-500`} />
              <span className={`text-[8px] uppercase tracking-widest ${textColor} text-center`}>{step.label}</span>
            </div>
            {i < steps.length - 1 && <div className="w-1" />}
          </React.Fragment>
        );
      })}
    </div>
  </div>
);

// --- display:alert ---
export const KyberionAlert = ({ severity, title, message }: {
  severity: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message?: string;
}) => {
  const config: Record<string, { border: string; bg: string; text: string; icon: React.ReactNode }> = {
    info:    { border: 'border-blue-500/30', bg: 'bg-blue-900/20', text: 'text-blue-400', icon: <Info size={14} /> },
    warning: { border: 'border-yellow-500/30', bg: 'bg-yellow-900/20', text: 'text-yellow-400', icon: <AlertTriangle size={14} /> },
    error:   { border: 'border-red-500/30', bg: 'bg-red-900/20', text: 'text-red-400', icon: <AlertTriangle size={14} /> },
    success: { border: 'border-green-500/30', bg: 'bg-green-900/20', text: 'text-green-400', icon: <CheckCircle size={14} /> },
  };
  const c = config[severity] || config.info;
  return (
    <div className={`flex gap-3 p-4 rounded-xl border ${c.border} ${c.bg}`}>
      <div className={c.text}>{c.icon}</div>
      <div className="flex-1">
        <div className={`text-[10px] font-bold uppercase tracking-widest ${c.text}`}>{title}</div>
        {message && <div className="text-[9px] opacity-50 mt-1">{message}</div>}
      </div>
    </div>
  );
};

// --- display:hero ---
export const KyberionHero = ({
  title,
  description,
  eyebrow,
  status,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  status?: string;
}) => (
  <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
    {eyebrow && <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/55">{eyebrow}</div>}
    <div className="mt-2 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-white/92">{title}</h2>
        {description && <p className="mt-2 text-[12px] leading-6 text-slate-200/62">{description}</p>}
      </div>
      {status && <div className="rounded-full border border-amber-200/15 bg-amber-300/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-amber-100/80">{status}</div>}
    </div>
  </div>
);

// --- display:badges ---
export const KyberionBadges = ({
  title,
  items,
}: {
  title?: string;
  items: { label: string; tone?: "neutral" | "info" | "success" | "warning" | "danger" }[];
}) => {
  const toneClass: Record<string, string> = {
    neutral: "border-white/10 bg-white/5 text-slate-200/75",
    info: "border-cyan-200/20 bg-cyan-300/10 text-cyan-100/85",
    success: "border-emerald-200/20 bg-emerald-300/10 text-emerald-100/85",
    warning: "border-amber-200/20 bg-amber-300/10 text-amber-100/85",
    danger: "border-rose-200/20 bg-rose-300/10 text-rose-100/85",
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {title && <div className="text-[10px] uppercase tracking-widest opacity-60 text-slate-300/80">{title}</div>}
      <div className="flex flex-wrap gap-2">
        {items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em] ${toneClass[item.tone || "neutral"]}`}
          >
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
};

// --- display:section ---
export const KyberionSection = ({
  title,
  description,
  items,
}: {
  title: string;
  description?: string;
  items: { type: string; props: Record<string, any> }[];
}) => (
  <div className="flex flex-col gap-4 rounded-[24px] border border-white/8 bg-slate-950/50 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
    <div>
      <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">{title}</div>
      {description && <div className="mt-1 text-[11px] leading-5 text-slate-200/52">{description}</div>}
    </div>
    <div className="flex flex-col gap-4">
      {items.map((item, index) => {
        const Component = A2UI_COMPONENT_REGISTRY[item.type];
        return Component ? <Component key={`${item.type}-${index}`} {...item.props} /> : null;
      })}
    </div>
  </div>
);

// --- display:code ---
export const KyberionCode = ({ title, language, code }: {
  title?: string; language?: string; code: string;
}) => (
  <div className="flex flex-col gap-2 w-full">
    {(title || language) && (
      <div className="flex justify-between text-[9px] uppercase tracking-widest opacity-40">
        <span>{title || ''}</span>
        {language && <span className="font-mono">{language}</span>}
      </div>
    )}
    <pre className="bg-black/60 rounded-xl p-4 font-mono text-[10px] overflow-x-auto border border-white/5 text-green-300/70 whitespace-pre-wrap">
      {code}
    </pre>
  </div>
);

// --- display:list ---
export const KyberionList = ({ title, items }: {
  title?: string;
  items: { label: string; detail?: string; icon?: string }[];
}) => (
  <div className="flex flex-col gap-3 w-full">
    {title && <div className="text-[10px] uppercase tracking-widest opacity-60">{title}</div>}
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 p-2 rounded-lg hover:bg-white/[0.02] transition">
          <span className="text-[11px] mt-0.5">{item.icon || '▸'}</span>
          <div className="flex-1">
            <div className="text-[10px] opacity-70">{item.label}</div>
            {item.detail && <div className="text-[9px] opacity-30 mt-0.5">{item.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  </div>
);

// --- display:card ---
export const KyberionCard = ({ title, description, icon, footer }: {
  title: string; description?: string; icon?: string; footer?: string;
}) => (
  <div className="bg-black/30 rounded-xl p-5 border border-white/5 flex flex-col gap-2">
    <div className="flex items-center gap-2">
      {icon && <span className="text-lg">{icon}</span>}
      <div className="text-[11px] font-bold uppercase tracking-widest opacity-70">{title}</div>
    </div>
    {description && <div className="text-[10px] opacity-50 leading-relaxed">{description}</div>}
    {footer && <div className="text-[8px] opacity-30 mt-2 pt-2 border-t border-white/5 font-mono">{footer}</div>}
  </div>
);

// --- display:grid (layout container) ---
export const KyberionGrid = ({ cols, children: items }: {
  cols?: number;
  children: { type: string; props: Record<string, any> }[];
}) => (
  <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols || 2}, 1fr)` }}>
    {(items || []).map((item, i) => {
      const Component = A2UI_COMPONENT_REGISTRY[item.type];
      return Component ? <Component key={i} {...item.props} /> : null;
    })}
  </div>
);

/**
 * Registry mapping A2UI component types to React components.
 */
export const A2UI_COMPONENT_REGISTRY: Record<string, React.FC<any>> = {
  'display:hero':        KyberionHero,
  'display:badges':      KyberionBadges,
  'display:section':     KyberionSection,
  'display:gauge':       KyberionGauge,
  'display:log':         KyberionLog,
  'display:table':       KyberionTable,
  'display:status':      KyberionStatus,
  'display:kv':          KyberionKeyValue,
  'display:metric':      KyberionMetric,
  'display:metrics-row': KyberionMetricsRow,
  'display:timeline':    KyberionTimeline,
  'display:progress':    KyberionProgress,
  'display:alert':       KyberionAlert,
  'display:code':        KyberionCode,
  'display:list':        KyberionList,
  'display:card':        KyberionCard,
  'display:grid':        KyberionGrid,
};

/** Sanitize string props to prevent XSS via script injection */
function sanitizeProps(props: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string') {
      clean[key] = value
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/on\w+\s*=/gi, 'data-blocked=');
    } else if (Array.isArray(value)) {
      clean[key] = value.map(item =>
        typeof item === 'object' && item !== null ? sanitizeProps(item) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitizeProps(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Renders an A2UI component by type lookup with prop sanitization.
 */
export const A2UIRenderer = ({ type, props }: { type: string; props: Record<string, any> }) => {
  // Security: Only render whitelisted component types
  const Component = A2UI_COMPONENT_REGISTRY[type];
  if (!Component) {
    return <div className="text-[9px] opacity-30 italic p-2">Unknown component: {type}</div>;
  }
  return <Component {...sanitizeProps(props)} />;
};
