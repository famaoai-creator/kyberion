import type { ReactNode } from 'react';

export function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] kb-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight kb-text-primary">{value}</div>
      <div className="mt-1 text-[10px] kb-text-muted">{detail}</div>
    </div>
  );
}

export function MiniSummaryCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] kb-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight kb-text-primary">{value}</div>
      <div className="mt-1 text-[10px] kb-text-muted">{detail}</div>
    </div>
  );
}

export function Panel({
  id,
  title,
  children,
  visible = true,
}: {
  id?: string;
  title: string;
  children: ReactNode;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <div id={id} className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4 scroll-mt-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.3em] kb-status-warning">{title}</div>
      </div>
      {children}
    </div>
  );
}

export function RuntimeCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'emerald' | 'gold' | 'red' | 'cyan';
}) {
  const accentClass = {
    emerald: 'kb-status-positive',
    gold: 'kb-status-warning',
    red: 'kb-status-negative',
    cyan: 'kb-text-accent',
  }[accent];

  return (
    <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
      <div className="text-[9px] uppercase tracking-[0.22em] kb-text-muted">{label}</div>
      <div className={`mt-2 text-lg font-semibold ${accentClass}`}>{value}</div>
    </div>
  );
}

export function providerResolutionSummary(
  metadata?: Record<string, unknown>
): { preferred: string; strategy: string } | null {
  const resolution = metadata?.provider_resolution;
  if (!resolution || typeof resolution !== 'object') return null;
  const record = resolution as Record<string, unknown>;
  const preferredProvider =
    typeof record.preferredProvider === 'string' ? record.preferredProvider : '';
  const preferredModelId =
    typeof record.preferredModelId === 'string' ? record.preferredModelId : '';
  const strategy = typeof record.strategy === 'string' ? record.strategy : 'preferred';
  if (!preferredProvider) return null;
  return {
    preferred: `${preferredProvider}${preferredModelId ? `/${preferredModelId}` : ''}`,
    strategy,
  };
}
