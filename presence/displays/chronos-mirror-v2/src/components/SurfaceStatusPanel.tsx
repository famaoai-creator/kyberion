'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Radar } from 'lucide-react';

type SurfaceStatusTone = 'neutral' | 'info' | 'warning' | 'error' | 'success';

const TONE_STYLES: Record<
  SurfaceStatusTone,
  { border: string; bg: string; text: string; icon: ReactNode }
> = {
  neutral: {
    border: 'kb-border-subtle',
    bg: 'kb-surface-sunken',
    text: 'kb-text-secondary',
    icon: <Radar size={14} className="kb-text-accent" />,
  },
  info: {
    border: 'kb-border-accent',
    bg: 'kb-surface-accent',
    text: 'kb-text-accent',
    icon: <Info size={14} className="kb-text-accent" />,
  },
  warning: {
    border: 'kb-status-warning-border',
    bg: 'kb-status-warning-surface',
    text: 'kb-status-warning',
    icon: <AlertTriangle size={14} className="kb-status-warning" />,
  },
  error: {
    border: 'kb-status-negative-border',
    bg: 'kb-status-negative-surface',
    text: 'kb-status-negative',
    icon: <AlertTriangle size={14} className="kb-status-negative" />,
  },
  success: {
    border: 'kb-status-positive-border',
    bg: 'kb-status-positive-surface',
    text: 'kb-status-positive',
    icon: <CheckCircle2 size={14} className="kb-status-positive" />,
  },
};

export function SurfaceStatusPanel({
  eyebrow,
  title,
  detail,
  tone = 'neutral',
  meta,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  eyebrow?: string;
  title: string;
  detail: string;
  tone?: SurfaceStatusTone;
  meta?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}) {
  const style = TONE_STYLES[tone];

  return (
    <div className={`rounded-[24px] border ${style.border} ${style.bg} px-5 py-4`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border kb-border-subtle kb-surface-sunken">
          {style.icon}
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">{eyebrow}</div>
          ) : null}
          <div className="mt-1 text-sm font-semibold tracking-tight kb-text-primary">{title}</div>
          <p className={`mt-2 text-[11px] leading-6 ${style.text}`}>{detail}</p>
          {meta ? (
            <div className="mt-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted">{meta}</div>
          ) : null}
        </div>
      </div>

      {actionLabel || secondaryActionLabel ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {actionLabel && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="inline-flex items-center gap-2 rounded-full border kb-border-subtle kb-surface-raised/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
            >
              {actionLabel}
              <ArrowRight size={12} />
            </button>
          ) : null}
          {secondaryActionLabel && onSecondaryAction ? (
            <button
              type="button"
              onClick={onSecondaryAction}
              className="inline-flex items-center gap-2 rounded-full border kb-border-subtle kb-surface-sunken px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
            >
              {secondaryActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
