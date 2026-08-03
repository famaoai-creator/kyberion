import React from 'react';
import {
  Info,
  AlertTriangle,
  CheckCircle,
  Activity,
  Clock,
  ArrowUp,
  ArrowDown,
  Minus,
} from 'lucide-react';
import { uxText, uxTextOr } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import {
  KyberionDonut,
  KyberionBarChart,
  KyberionStackedBar,
  KyberionSparkline,
} from './KyberionCharts';

/**
 * A2UI Component Library for Chronos Mirror v2
 */

const A2UI_FALLBACK_KEYS: Record<string, string> = {
  Intent: 'chronos_a2ui_intent',
  Plan: 'chronos_a2ui_plan',
  State: 'chronos_a2ui_state',
  Result: 'chronos_a2ui_result',
  Status: 'chronos_a2ui_status',
  Progress: 'chronos_a2ui_progress',
  Preview: 'chronos_a2ui_preview',
  'file missing': 'chronos_a2ui_file_missing',
  'Intervention Required': 'chronos_a2ui_intervention_required',
  'Pipeline Execution': 'chronos_a2ui_pipeline_execution',
  'Execution Output': 'chronos_a2ui_execution_output',
  Readiness: 'chronos_a2ui_readiness',
  Schedule: 'chronos_a2ui_schedule',
  'Operator Snapshot': 'chronos_a2ui_operator_snapshot',
  'Chronos Dashboard': 'chronos_a2ui_dashboard',
  'Active Missions': 'chronos_a2ui_active_missions',
  'Mission Control': 'chronos_a2ui_mission_control',
  'Visible Missions': 'chronos_a2ui_visible_missions',
  'Mission Registry View': 'chronos_a2ui_mission_registry',
  'Agent Catalog': 'chronos_a2ui_agent_catalog',
  'Available Agents': 'chronos_a2ui_available_agents',
  'Vital Check': 'chronos_a2ui_vital_check',
  'System Vital Signs': 'chronos_a2ui_system_vital_signs',
  'Runtime Diagnostics': 'chronos_a2ui_runtime_diagnostics',
  'Recent Events': 'chronos_a2ui_recent_events',
  Governance: 'chronos_a2ui_governance',
  'Build & Test': 'chronos_a2ui_build_test',
  missions: 'chronos_a2ui_missions',
  runtime: 'chronos_a2ui_runtime',
  runtimes: 'chronos_a2ui_runtimes',
  outbox: 'chronos_a2ui_outbox',
  exit: 'chronos_a2ui_exit_code',
  Tier: 'chronos_a2ui_tier',
  Type: 'chronos_a2ui_type',
  Next: 'chronos_a2ui_next',
  Provider: 'chronos_a2ui_provider',
  Model: 'chronos_a2ui_model',
  Capabilities: 'chronos_a2ui_capabilities',
  Checkpoints: 'chronos_a2ui_checkpoints',
  'Next Tasks': 'chronos_a2ui_next_tasks',
};

function useA2UIText() {
  const locale = useChronosLocale();
  return (key: string | undefined, fallbackEn: string) => {
    const resolvedKey = key || A2UI_FALLBACK_KEYS[fallbackEn];
    return resolvedKey ? uxTextOr(resolvedKey, fallbackEn, locale) : fallbackEn;
  };
}

// --- display:gauge ---
export const KyberionGauge = ({
  label,
  labelKey,
  value,
  unit,
}: {
  label: string;
  labelKey?: string;
  value: number;
  unit: string;
}) => {
  const tx = useA2UIText();
  const percentage = Math.min(100, Math.max(0, value));
  const color =
    percentage >= 80
      ? 'kb-status-positive-surface'
      : percentage >= 50
        ? 'kb-status-warning-surface'
        : 'kb-status-negative-surface';
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex justify-between text-[10px] uppercase tracking-widest opacity-60">
        <span>{tx(labelKey, label)}</span>
        <span>
          {value}
          {unit}
        </span>
      </div>
      <div className="h-1.5 w-full kb-surface-raised/5 rounded-full overflow-hidden border kb-border-subtle">
        <div
          className={`h-full ${color} transition-all duration-1000 ease-out`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

// --- display:log ---
export const KyberionLog = ({
  title,
  titleKey,
  lines,
}: {
  title: string;
  titleKey?: string;
  lines: string[];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="text-[10px] uppercase tracking-widest opacity-60 flex items-center gap-2 kb-text-secondary">
        <Info size={12} /> {tx(titleKey, title)}
      </div>
      <div className="kb-surface-well rounded-2xl p-4 font-mono text-[10px] space-y-1 overflow-y-auto max-h-[320px] border kb-border-subtle shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {lines.map((line, i) => (
          <div key={i} className="opacity-70 border-l kb-border-accent pl-3 leading-5 break-words">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

// --- display:table ---
export const KyberionTable = ({
  title,
  titleKey,
  headers,
  headerKeys,
  rows,
}: {
  title?: string;
  titleKey?: string;
  headers: string[];
  headerKeys?: string[];
  rows: string[][];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && (
        <div className="text-[10px] uppercase tracking-widest opacity-60 kb-text-secondary">
          {tx(titleKey, title)}
        </div>
      )}
      <div className="kb-surface-well rounded-2xl border kb-border-subtle overflow-hidden overflow-x-auto shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b kb-border-subtle kb-surface-raised">
              {headers.map((h, i) => (
                <th
                  key={i}
                  className="px-4 py-3 text-left uppercase tracking-widest kb-text-secondary font-bold whitespace-nowrap"
                >
                  {tx(headerKeys?.[i], h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b kb-border-subtle hover:kb-surface-raised transition">
                {(Array.isArray(row) ? row : Object.values(row)).map((cell: any, ci: number) => (
                  <td key={ci} className="px-4 py-3 kb-text-secondary align-top">
                    {typeof cell === 'object' ? JSON.stringify(cell) : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// --- display:status ---
export const KyberionStatus = ({
  label,
  labelKey,
  status,
  detail,
  detailKey,
}: {
  label: string;
  labelKey?: string;
  status: string;
  detail?: string;
  detailKey?: string;
}) => {
  const tx = useA2UIText();
  const config: Record<string, { icon: React.ReactNode; border: string }> = {
    ok: {
      icon: <CheckCircle size={14} className="kb-status-positive" />,
      border: 'kb-status-positive-border',
    },
    warning: {
      icon: <AlertTriangle size={14} className="kb-status-warning" />,
      border: 'kb-status-warning-border',
    },
    error: {
      icon: <AlertTriangle size={14} className="kb-status-negative" />,
      border: 'kb-status-negative-border',
    },
    pending: {
      icon: <Activity size={14} className="kb-text-secondary animate-pulse" />,
      border: 'kb-border-subtle',
    },
  };
  const c = config[status] || config.pending;
  return (
    <div
      className={`flex items-center gap-3 p-3 kb-surface-well rounded-xl border ${c.border} shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]`}
    >
      {c.icon}
      <div className="flex-1">
        <div className="text-[10px] uppercase tracking-widest kb-text-secondary font-bold">
          {tx(labelKey, label)}
        </div>
        {detail && (
          <div className="text-[9px] kb-text-secondary mt-0.5">{tx(detailKey, detail)}</div>
        )}
      </div>
      <div className="text-[9px] uppercase tracking-widest kb-text-secondary">{status}</div>
    </div>
  );
};

// --- display:kv ---
export const KyberionKeyValue = ({
  title,
  titleKey,
  entries,
}: {
  title?: string;
  titleKey?: string;
  entries: { key: string; keyKey?: string; value: string }[];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && (
        <div className="text-[10px] uppercase tracking-widest opacity-60">
          {tx(titleKey, title)}
        </div>
      )}
      <div className="kb-surface-well rounded-xl p-4 border kb-border-subtle space-y-2">
        {(entries || []).map((entry, i) => (
          <div key={i} className="flex justify-between text-[10px]">
            <span className="opacity-40 uppercase tracking-widest">
              {tx(entry.keyKey, entry.key)}
            </span>
            <span className="opacity-70 font-mono">{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- display:metric (big number with trend) ---
export const KyberionMetric = ({
  label,
  labelKey,
  value,
  unit,
  trend,
  description,
  descriptionKey,
}: {
  label: string;
  labelKey?: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  description?: string;
  descriptionKey?: string;
}) => {
  const tx = useA2UIText();
  const trendIcon =
    trend === 'up' ? (
      <ArrowUp size={12} className="kb-status-positive" />
    ) : trend === 'down' ? (
      <ArrowDown size={12} className="kb-status-negative" />
    ) : (
      <Minus size={12} className="opacity-30" />
    );
  return (
    <div className="kb-surface-well rounded-2xl p-4 border kb-border-subtle flex flex-col gap-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="text-[9px] uppercase tracking-widest kb-text-secondary">
        {tx(labelKey, label)}
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold font-mono kb-text-primary">{value}</span>
        {unit && <span className="text-[10px] kb-text-secondary mb-1">{unit}</span>}
        {trend && <span className="mb-1">{trendIcon}</span>}
      </div>
      {description && (
        <div className="text-[9px] kb-text-secondary mt-1">{tx(descriptionKey, description)}</div>
      )}
    </div>
  );
};

// --- display:metrics-row (multiple metrics in a row) ---
export const KyberionMetricsRow = ({
  metrics,
}: {
  metrics: {
    label: string;
    labelKey?: string;
    value: string | number;
    unit?: string;
    trend?: 'up' | 'down' | 'flat';
    description?: string;
    descriptionKey?: string;
  }[];
}) => (
  <div
    className="grid gap-4"
    style={{ gridTemplateColumns: `repeat(${Math.min(metrics.length, 4)}, 1fr)` }}
  >
    {metrics.map((m, i) => (
      <KyberionMetric key={i} {...m} />
    ))}
  </div>
);

// --- display:timeline ---
export const KyberionTimeline = ({
  title,
  titleKey,
  events,
}: {
  title?: string;
  titleKey?: string;
  events: {
    time: string;
    label: string;
    labelKey?: string;
    status?: string;
    detail?: string;
    detailKey?: string;
  }[];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && (
        <div className="text-[10px] uppercase tracking-widest opacity-60 flex items-center gap-2">
          <Clock size={12} /> {tx(titleKey, title)}
        </div>
      )}
      <div className="relative pl-6 space-y-4">
        <div className="absolute left-2 top-1 bottom-1 w-px kb-status-warning-surface" />
        {events.map((event, i) => {
          const dotColor =
            event.status === 'error'
              ? 'kb-status-negative-surface'
              : event.status === 'warning'
                ? 'kb-status-warning-surface'
                : event.status === 'ok'
                  ? 'kb-status-positive-surface'
                  : 'kb-status-warning-surface';
          return (
            <div key={i} className="relative">
              <div
                className={`absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full ${dotColor} border-2 kb-border-subtle`}
              />
              <div className="text-[9px] font-mono opacity-40">{event.time}</div>
              <div className="text-[10px] opacity-70 font-bold">
                {tx(event.labelKey, event.label)}
              </div>
              {event.detail && (
                <div className="text-[9px] opacity-30 mt-0.5">
                  {tx(event.detailKey, event.detail)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- display:progress (multi-step pipeline) ---
export const KyberionProgress = ({
  title,
  titleKey,
  steps,
}: {
  title?: string;
  titleKey?: string;
  steps: { label: string; labelKey?: string; status: 'done' | 'active' | 'pending' }[];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && (
        <div className="text-[10px] uppercase tracking-widest opacity-60">
          {tx(titleKey, title)}
        </div>
      )}
      <div className="flex items-center gap-1">
        {steps.map((step, i) => {
          const bg =
            step.status === 'done'
              ? 'kb-status-positive-surface'
              : step.status === 'active'
                ? 'kb-status-warning-surface animate-pulse'
                : 'kb-surface-raised';
          const textColor = step.status === 'pending' ? 'opacity-30' : 'opacity-80';
          return (
            <React.Fragment key={i}>
              <div className="flex flex-col items-center gap-1 flex-1">
                <div className={`w-full h-2 rounded-full ${bg} transition-all duration-500`} />
                <span className={`text-[8px] uppercase tracking-widest ${textColor} text-center`}>
                  {tx(step.labelKey, step.label)}
                </span>
              </div>
              {i < steps.length - 1 && <div className="w-1" />}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

// --- display:alert ---
export const KyberionAlert = ({
  severity,
  title,
  titleKey,
  message,
  messageKey,
}: {
  severity: 'info' | 'warning' | 'error' | 'success';
  title: string;
  titleKey?: string;
  message?: string;
  messageKey?: string;
}) => {
  const tx = useA2UIText();
  const config: Record<
    string,
    { border: string; bg: string; text: string; icon: React.ReactNode }
  > = {
    info: {
      border: 'kb-border-accent',
      bg: 'kb-surface-accent',
      text: 'kb-text-accent',
      icon: <Info size={14} />,
    },
    warning: {
      border: 'kb-status-warning-border',
      bg: 'kb-status-warning-surface',
      text: 'kb-status-warning',
      icon: <AlertTriangle size={14} />,
    },
    error: {
      border: 'kb-status-negative-border',
      bg: 'kb-status-negative-surface',
      text: 'kb-status-negative',
      icon: <AlertTriangle size={14} />,
    },
    success: {
      border: 'kb-status-positive-border',
      bg: 'kb-status-positive-surface',
      text: 'kb-status-positive',
      icon: <CheckCircle size={14} />,
    },
  };
  const c = config[severity] || config.info;
  return (
    <div className={`flex gap-3 p-4 rounded-xl border ${c.border} ${c.bg}`}>
      <div className={c.text}>{c.icon}</div>
      <div className="flex-1">
        <div className={`text-[10px] font-bold uppercase tracking-widest ${c.text}`}>
          {tx(titleKey, title)}
        </div>
        {message && <div className="text-[9px] opacity-50 mt-1">{tx(messageKey, message)}</div>}
      </div>
    </div>
  );
};

// --- display:hero ---
export const KyberionHero = ({
  title,
  titleKey,
  description,
  descriptionKey,
  eyebrow,
  eyebrowKey,
  status,
  statusKey,
}: {
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  eyebrow?: string;
  eyebrowKey?: string;
  status?: string;
  statusKey?: string;
}) => {
  const tx = useA2UIText();
  return (
    <div className="rounded-[24px] border kb-border-subtle bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      {eyebrow && (
        <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
          {tx(eyebrowKey, eyebrow)}
        </div>
      )}
      <div className="mt-2 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight kb-text-primary">
            {tx(titleKey, title)}
          </h2>
          {description && (
            <p className="mt-2 text-[12px] leading-6 kb-text-secondary">
              {tx(descriptionKey, description)}
            </p>
          )}
        </div>
        {status && (
          <div className="rounded-full border kb-status-warning-border kb-status-warning-surface px-3 py-1 text-[10px] uppercase tracking-[0.2em] kb-status-warning">
            {tx(statusKey, status)}
          </div>
        )}
      </div>
    </div>
  );
};

// --- display:badges ---
export const KyberionBadges = ({
  title,
  titleKey,
  items,
}: {
  title?: string;
  titleKey?: string;
  items: {
    label: string;
    labelKey?: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  }[];
}) => {
  const tx = useA2UIText();
  const toneClass: Record<string, string> = {
    neutral: 'kb-border-subtle kb-surface-raised/5 kb-text-secondary',
    info: 'kb-border-accent kb-surface-accent kb-text-accent',
    success: 'kb-status-positive-border kb-status-positive-surface kb-status-positive',
    warning: 'kb-status-warning-border kb-status-warning-surface kb-status-warning',
    danger: 'kb-status-negative-border kb-status-negative-surface kb-status-negative',
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {title && (
        <div className="text-[10px] uppercase tracking-widest opacity-60 kb-text-secondary">
          {tx(titleKey, title)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em] ${toneClass[item.tone || 'neutral']}`}
          >
            {tx(item.labelKey, item.label)}
          </div>
        ))}
      </div>
    </div>
  );
};

// --- display:section ---
export const KyberionSection = ({
  title,
  titleKey,
  description,
  descriptionKey,
  items,
}: {
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  items: { type: string; props: Record<string, any> }[];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-4 rounded-[24px] border kb-border-subtle kb-surface-well p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div>
        <div className="text-[10px] uppercase tracking-[0.24em] kb-text-muted">
          {tx(titleKey, title)}
        </div>
        {description && (
          <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
            {tx(descriptionKey, description)}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4">
        {items.map((item, index) => {
          const Component = A2UI_COMPONENT_REGISTRY[item.type];
          return Component ? <Component key={`${item.type}-${index}`} {...item.props} /> : null;
        })}
      </div>
    </div>
  );
};

// --- display:code ---
export const KyberionCode = ({
  title,
  titleKey,
  language,
  code,
}: {
  title?: string;
  titleKey?: string;
  language?: string;
  code: string;
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-2 w-full">
      {(title || language) && (
        <div className="flex justify-between text-[9px] uppercase tracking-widest opacity-40">
          <span>{title ? tx(titleKey, title) : ''}</span>
          {language && <span className="font-mono">{language}</span>}
        </div>
      )}
      <pre className="kb-surface-well rounded-xl p-4 font-mono text-[10px] overflow-x-auto border kb-border-subtle kb-status-positive whitespace-pre-wrap">
        {code}
      </pre>
    </div>
  );
};

// --- display:list ---
export const KyberionList = ({
  title,
  titleKey,
  items,
}: {
  title?: string;
  titleKey?: string;
  items: { label: string; labelKey?: string; detail?: string; detailKey?: string; icon?: string }[];
}) => {
  const tx = useA2UIText();
  return (
    <div className="flex flex-col gap-3 w-full">
      {title && (
        <div className="text-[10px] uppercase tracking-widest opacity-60">
          {tx(titleKey, title)}
        </div>
      )}
      <div className="space-y-1">
        {items.map((item, i) => (
          <div
            key={i}
            className="flex items-start gap-2 p-2 rounded-lg hover:kb-surface-raised transition"
          >
            <span className="text-[11px] mt-0.5">{item.icon || '▸'}</span>
            <div className="flex-1">
              <div className="text-[10px] opacity-70">{tx(item.labelKey, item.label)}</div>
              {item.detail && (
                <div className="text-[9px] opacity-30 mt-0.5">
                  {tx(item.detailKey, item.detail)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- display:card ---
export const KyberionCard = ({
  title,
  titleKey,
  description,
  descriptionKey,
  icon,
  footer,
  footerKey,
}: {
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  footer?: string;
  footerKey?: string;
}) => {
  const tx = useA2UIText();
  return (
    <div className="kb-surface-well rounded-xl p-5 border kb-border-subtle flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {icon && <span className="text-lg">{icon}</span>}
        <div className="text-[11px] font-bold uppercase tracking-widest opacity-70">
          {tx(titleKey, title)}
        </div>
      </div>
      {description && (
        <div className="text-[10px] opacity-50 leading-relaxed">
          {tx(descriptionKey, description)}
        </div>
      )}
      {footer && (
        <div className="text-[8px] opacity-30 mt-2 pt-2 border-t kb-border-subtle font-mono">
          {tx(footerKey, footer)}
        </div>
      )}
    </div>
  );
};

// --- display:grid (layout container) ---
export const KyberionGrid = ({
  cols,
  children: items,
}: {
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

// --- kb:layout-grid ---
export const KbLayoutGrid = ({
  columns = 2,
  gap = '1rem',
  children: items,
  variant = 'dashboard',
}: {
  columns?: number;
  gap?: string;
  children: { type: string; props: Record<string, any> }[];
  variant?: string;
}) => (
  <div
    className={`grid ${variant === 'mission-focus' ? 'p-6 kb-surface-well' : ''}`}
    style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gap }}
  >
    {(items || []).map((item, i) => (
      <A2UIRenderer key={i} type={item.type} props={item.props} />
    ))}
  </div>
);

// --- kb:status-orbit ---
export const KbStatusOrbit = ({
  currentPhase,
  status,
  label,
  labelKey,
  phaseKeys,
}: {
  currentPhase: 'intent' | 'plan' | 'state' | 'result';
  status: string;
  label: string;
  labelKey?: string;
  phaseKeys?: Partial<Record<'intent' | 'plan' | 'state' | 'result', string>>;
}) => {
  const tx = useA2UIText();
  const phases = ['intent', 'plan', 'state', 'result'];
  const currentIndex = phases.indexOf(currentPhase);

  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="relative w-48 h-48 flex items-center justify-center">
        {/* Static Background Ring */}
        <div className="absolute inset-0 rounded-full border-2 kb-border-subtle" />

        {/* Dynamic Pulse Ring */}
        <div
          className={`absolute inset-0 rounded-full border-2 kb-border-accent ${status === 'running' ? 'animate-ping' : ''}`}
        />

        {/* Phase Indicators */}
        {phases.map((phase, i) => {
          const angle = i * 90 - 90;
          const isActive = i <= currentIndex;
          const isCurrent = i === currentIndex;

          return (
            <div
              key={phase}
              className="absolute transition-all duration-500"
              style={{
                transform: `rotate(${angle}deg) translate(96px) rotate(-${angle}deg)`,
              }}
            >
              <div
                className={`w-3 h-3 rounded-full border-2 ${
                  isCurrent
                    ? 'kb-surface-accent kb-border-accent shadow-[0_0_10px_#00f2ff]'
                    : isActive
                      ? 'kb-surface-accent kb-border-accent'
                      : 'kb-surface-well kb-border-subtle'
                }`}
              />
              <div
                className={`absolute top-5 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-tighter ${isActive ? 'kb-text-accent' : 'kb-text-secondary'}`}
              >
                {tx(phaseKeys?.[phase as keyof typeof phaseKeys], phase)}
              </div>
            </div>
          );
        })}

        {/* Center Text */}
        <div className="text-center px-4">
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-1">
            {tx('chronos_a2ui_status', 'Status')}
          </div>
          <div
            className={`text-sm font-bold uppercase tracking-widest ${status === 'running' ? 'pulse-animation kb-text-accent' : 'kb-text-primary'}`}
          >
            {tx(labelKey, label)}
          </div>
        </div>
      </div>
    </div>
  );
};

// --- kb:mission-card ---
export const KbMissionCard = ({
  missionId,
  title,
  titleKey,
  owner,
  ownerKey,
  progress,
  priority,
  priorityKey,
}: {
  missionId: string;
  title: string;
  titleKey?: string;
  owner: string;
  ownerKey?: string;
  progress: number;
  priority: string;
  priorityKey?: string;
}) => {
  const tx = useA2UIText();
  const priorityColors = {
    low: 'kb-text-secondary',
    medium: 'kb-text-accent',
    high: 'kb-status-warning',
    critical: 'kb-status-negative shadow-[0_0_10px_rgba(239,68,68,0.3)]',
  };

  return (
    <div className="kyberion-glass p-4 rounded-xl flex flex-col gap-3 group hover:kb-border-accent transition-all">
      <div className="flex justify-between items-start">
        <div className="text-[10px] font-mono kb-text-accent uppercase">{missionId}</div>
        <div
          className={`text-[9px] uppercase font-bold tracking-widest ${(priorityColors as any)[priority] || priorityColors.medium}`}
        >
          {tx(priorityKey, priority)}
        </div>
      </div>
      <div className="text-sm font-bold kb-text-primary group-hover:kb-text-accent transition-colors">
        {tx(titleKey, title)}
      </div>
      <div className="flex items-center gap-2 opacity-40 text-[10px]">
        <Activity size={10} /> {tx(ownerKey, owner)}
      </div>
      <div className="mt-2">
        <div className="h-1 w-full kb-surface-raised/5 rounded-full overflow-hidden">
          <div
            className="h-full kb-surface-accent transition-all duration-1000"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[8px] uppercase tracking-widest opacity-30">
          <span>{tx('chronos_a2ui_progress', 'Progress')}</span>
          <span>{progress}%</span>
        </div>
      </div>
    </div>
  );
};

// --- kb:artifact-tile ---
const ARTIFACT_KIND_ICON: Record<string, string> = {
  pptx: '📊',
  xlsx: '📈',
  docx: '📄',
  doc: '📄',
  md: '📝',
  markdown: '📝',
  pdf: '📕',
  html: '🌐',
  web: '🌐',
  png: '🖼',
  jpg: '🖼',
  image: '🖼',
  json: '🧾',
  code: '💻',
  audio: '🎧',
  video: '🎬',
};

export const KbArtifactTile = ({
  type,
  path,
  previewContent,
  missionId,
  updatedAt,
  missing,
  onSelect,
  onOpen,
  onPreview,
}: {
  type: string;
  path: string;
  previewContent: string;
  missionId?: string;
  updatedAt?: string;
  missing?: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  onPreview?: () => void;
}) => {
  const tx = useA2UIText();
  const fileName = path.split('/').filter(Boolean).pop() || path;
  const icon = ARTIFACT_KIND_ICON[type.toLowerCase()] || '📦';
  return (
    <div className="kb-surface-well border kb-border-subtle rounded-lg p-3 transition hover:kb-surface-well">
      <button type="button" onClick={onSelect || onPreview || onOpen} className="w-full text-left">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded kb-surface-accent flex items-center justify-center text-[14px]">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold kb-text-primary">{fileName}</div>
            <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.14em] kb-text-secondary">
              <span>{type}</span>
              {missionId ? <span className="truncate">· {missionId}</span> : null}
              {updatedAt ? <span>· {updatedAt.slice(0, 10)}</span> : null}
            </div>
          </div>
          {missing ? (
            <span className="rounded border kb-status-warning-border kb-status-warning-surface px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] kb-status-warning">
              {tx('chronos_a2ui_file_missing', 'file missing')}
            </span>
          ) : null}
        </div>
        <div className="mb-2 truncate text-[9px] font-mono kb-text-secondary">{path}</div>
        <div className="kb-surface-well p-2 rounded text-[9px] font-mono kb-text-secondary line-clamp-3">
          {previewContent}
        </div>
      </button>
      {(onOpen || onPreview) && !missing && (
        <div className="mt-2 flex gap-2">
          {onPreview && (
            <button
              type="button"
              onClick={onPreview}
              className="rounded border kb-border-accent kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
            >
              {tx('chronos_a2ui_preview', 'Preview')}
            </button>
          )}
          {onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className="rounded border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
            >
              {tx('chronos_cb_open', 'Open')}
            </button>
          )}
        </div>
      )}
      {missing ? (
        <div className="mt-2 text-[9px] kb-status-warning">
          {tx(
            'chronos_a2ui_original_file_cleaned',
            'The original file was cleaned up; only the record remains.'
          )}
        </div>
      ) : null}
    </div>
  );
};

// --- kb:intervention-panel ---
export const KbInterventionPanel = ({
  reason,
  reasonKey,
  title,
  titleKey,
  options,
  isBlocking,
  onSelectOption,
}: {
  reason: string;
  reasonKey?: string;
  title?: string;
  titleKey?: string;
  options: Array<{ label: string; variant?: 'primary' | 'danger' | 'neutral'; value?: string }>;
  isBlocking: boolean;
  onSelectOption?: (option: {
    label: string;
    variant?: 'primary' | 'danger' | 'neutral';
    value?: string;
  }) => void;
}) => {
  const tx = useA2UIText();
  return (
    <div
      className={`p-6 rounded-2xl border-2 ${isBlocking ? 'kb-status-warning-border kb-status-warning-surface' : 'kb-border-accent kb-surface-accent'} shadow-2xl`}
    >
      <div className="flex items-center gap-3 mb-4">
        <AlertTriangle className={isBlocking ? 'kb-status-warning' : 'kb-text-accent'} />
        <div className="text-xs font-bold uppercase tracking-[0.2em]">
          {tx(titleKey, title || 'Intervention Required')}
        </div>
      </div>
      <p className="text-sm kb-text-primary mb-6 leading-relaxed">{tx(reasonKey, reason)}</p>
      <div className="flex gap-3">
        {(options || []).map((opt, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSelectOption?.(opt)}
            className={`px-4 py-2 rounded text-[10px] uppercase font-bold tracking-widest transition-all ${
              opt.variant === 'primary'
                ? 'kb-surface-accent kb-text-inverse hover:kb-surface-accent'
                : opt.variant === 'danger'
                  ? 'kb-status-negative-surface kb-text-primary hover:kb-status-negative-surface'
                  : 'kb-surface-raised kb-text-primary hover:kb-surface-raised'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * Registry mapping A2UI component types to React components.
 */
export const A2UI_COMPONENT_REGISTRY: Record<string, React.FC<any>> = {
  'display:hero': KyberionHero,
  'display:badges': KyberionBadges,
  'display:section': KyberionSection,
  'display:gauge': KyberionGauge,
  'display:log': KyberionLog,
  'display:table': KyberionTable,
  'display:status': KyberionStatus,
  'display:kv': KyberionKeyValue,
  'display:metric': KyberionMetric,
  'display:metrics-row': KyberionMetricsRow,
  'display:timeline': KyberionTimeline,
  'display:progress': KyberionProgress,
  'display:alert': KyberionAlert,
  'display:code': KyberionCode,
  'display:list': KyberionList,
  'display:card': KyberionCard,
  'display:grid': KyberionGrid,
  // Charts (self-contained SVG)
  'display:donut': KyberionDonut,
  'display:bar-chart': KyberionBarChart,
  'display:stacked-bar': KyberionStackedBar,
  'display:sparkline': KyberionSparkline,
  // Chronos Specific (kb-*)
  'kb-layout-grid': KbLayoutGrid,
  'kb-status-orbit': KbStatusOrbit,
  'kb-mission-card': KbMissionCard,
  'kb-artifact-tile': KbArtifactTile,
  'kb-intervention-panel': KbInterventionPanel,
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
      clean[key] = value.map((item) =>
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

/** Action emitted when the operator interacts with an actionable A2UI component (SU-02). */
export interface A2UIComponentAction {
  componentType: string;
  action: 'select-option' | 'open' | 'preview';
  option?: { label: string; variant?: 'primary' | 'danger' | 'neutral'; value?: string };
  props: Record<string, any>;
}

/**
 * Renders an A2UI component by type lookup with prop sanitization.
 * When `onAction` is provided, actionable components (kb-intervention-panel,
 * kb-artifact-tile) get their callbacks wired so operator clicks actually
 * move things forward instead of being decorative.
 */
export const A2UIRenderer = ({
  type,
  props,
  onAction,
}: {
  type: string;
  props: Record<string, any>;
  onAction?: (action: A2UIComponentAction) => void;
}) => {
  // Security: Only render whitelisted component types
  const Component = A2UI_COMPONENT_REGISTRY[type];
  if (!Component) {
    return <div className="text-[9px] opacity-30 italic p-2">Unknown component: {type}</div>;
  }
  const clean = sanitizeProps(props);
  const actionProps: Record<string, unknown> = {};
  if (onAction && type === 'kb-intervention-panel') {
    actionProps.onSelectOption = (option: A2UIComponentAction['option']) =>
      onAction({ componentType: type, action: 'select-option', option, props: clean });
  }
  if (onAction && type === 'kb-artifact-tile') {
    actionProps.onOpen = () => onAction({ componentType: type, action: 'open', props: clean });
    actionProps.onPreview = () =>
      onAction({ componentType: type, action: 'preview', props: clean });
  }
  return <Component {...clean} {...actionProps} />;
};
