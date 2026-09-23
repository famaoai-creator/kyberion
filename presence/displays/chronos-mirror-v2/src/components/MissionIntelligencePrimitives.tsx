import type { ReactNode } from 'react';
import { Metric, Section } from '@agent/shared-ui';

/**
 * UI-07: the Mission Intelligence building blocks render the shared
 * `.kb-*` contract (Section / Metric) — no nested sunken boxes, no ad-hoc
 * Tailwind colors. Signatures stay stable so every panel migrates at once.
 */

type MetricTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: MetricTone;
}) {
  return <Metric label={label} value={value} description={detail} tone={tone} />;
}

export function MiniSummaryCard({
  label,
  value,
  detail,
}: {
  icon?: ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <Metric
      label={label}
      value={value}
      description={detail}
      tone={value > 0 ? 'warning' : undefined}
    />
  );
}

/**
 * A titled block of the Mission Intelligence page. `description` replaces
 * the old boxed explanation paragraphs; `actions` sits in the header.
 */
export function Panel({
  id,
  title,
  description,
  actions,
  className,
  children,
  visible = true,
}: {
  id?: string;
  className?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <div id={id} className={`scroll-mt-6 min-w-0 ${className ?? ''}`.trim()}>
      <Section title={title} description={description} headingLevel={3}>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        {children}
      </Section>
    </div>
  );
}

const RUNTIME_TONE: Record<'emerald' | 'gold' | 'red' | 'cyan', MetricTone> = {
  emerald: 'success',
  gold: 'warning',
  red: 'danger',
  cyan: 'info',
};

export function RuntimeCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'emerald' | 'gold' | 'red' | 'cyan';
}) {
  return <Metric label={label} value={value} tone={value > 0 ? RUNTIME_TONE[accent] : undefined} />;
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
