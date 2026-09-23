'use client';

import type { ReactNode } from 'react';
import type {
  KbBadgeProps,
  KbCalloutProps,
  KbEmptyStateProps,
  KbSkeletonProps,
  KbStatusPillProps,
} from '@agent/core/a2ui-catalog';
import { statusLabelJa, statusTone } from '../catalog.js';
import { ActionRefButton } from './controls.js';

const TONES: ReadonlySet<string> = new Set([
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
]);
const CALLOUT_TONES: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'danger']);
const ROLES: ReadonlySet<string> = new Set([
  'concierge',
  'presence-studio',
  'chronos-mirror-v2',
  'operator-surface',
  'computer-surface',
]);

export function toneAttr(tone: unknown): string | undefined {
  return typeof tone === 'string' && TONES.has(tone) ? tone : undefined;
}

export function roleAttr(role: unknown): string | undefined {
  return typeof role === 'string' && ROLES.has(role) ? role : undefined;
}

/**
 * `ui:status-pill` → `.kb-status-pill[data-status][data-tone]`. The icon is
 * the stylesheet's glyph on an `aria-hidden` `__icon` span, so the pill carries icon + text and
 * never relies on color alone. Label: explicit `label`, else the Japanese
 * vocabulary label, else the raw status.
 */
export function StatusPill({ status, domain, label }: KbStatusPillProps) {
  const text = label || statusLabelJa(String(status), domain);
  return (
    <span
      className="kb-status-pill"
      data-status={status}
      data-tone={statusTone(String(status))}
      data-domain={domain}
    >
      <span className="kb-status-pill__icon" aria-hidden="true" />
      {text}
    </span>
  );
}

/** `ui:badge` → `.kb-badge[data-tone][data-role]`. */
export function Badge({ label, tone, role }: KbBadgeProps) {
  return (
    <span className="kb-badge" data-tone={toneAttr(tone)} data-role={roleAttr(role)}>
      {label}
    </span>
  );
}

/** `ui:callout` → `.kb-callout[data-tone]` with `__icon`, `__content`, `__title`, `__body`, `__action`. */
export function Callout({
  tone,
  title,
  body,
  action,
  children,
}: KbCalloutProps & { children?: ReactNode }) {
  const resolvedTone = typeof tone === 'string' && CALLOUT_TONES.has(tone) ? tone : 'info';
  return (
    <div
      className="kb-callout"
      data-tone={resolvedTone}
      role={resolvedTone === 'danger' ? 'alert' : 'note'}
    >
      <span className="kb-callout__icon" aria-hidden="true" />
      <div className="kb-callout__content">
        <p className="kb-callout__title">{title}</p>
        {body ? <p className="kb-callout__body">{body}</p> : null}
        {children}
        {action ? (
          <div className="kb-callout__action">
            <ActionRefButton actionRef={action} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** `ui:empty-state` → `.kb-empty-state` with `__title`, `__body`, `__action`. */
export function EmptyState({ title, body, action }: KbEmptyStateProps) {
  return (
    <div className="kb-empty-state">
      <p className="kb-empty-state__title">{title}</p>
      {body ? <p className="kb-empty-state__body">{body}</p> : null}
      {action ? (
        <div className="kb-empty-state__action">
          <ActionRefButton actionRef={action} defaultVariant="primary" />
        </div>
      ) : null}
    </div>
  );
}

const SKELETON_SHAPES: ReadonlySet<string> = new Set(['text', 'card', 'table']);

/** `ui:skeleton` → `.kb-skeleton[data-shape]` with `lines` × `.kb-skeleton__line`. */
export function Skeleton({
  lines,
  shape,
  label = '読み込み中',
}: KbSkeletonProps & { label?: string }) {
  const resolvedShape = typeof shape === 'string' && SKELETON_SHAPES.has(shape) ? shape : 'text';
  const defaultLines = resolvedShape === 'table' ? 5 : 3;
  const count = Math.min(12, Math.max(1, Math.floor(Number(lines) || defaultLines)));
  return (
    <div
      className="kb-skeleton"
      data-shape={resolvedShape}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="kb-skeleton__line" />
      ))}
    </div>
  );
}
