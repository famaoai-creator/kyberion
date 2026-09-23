import type { ReactNode } from 'react';
import { Disclosure, KeyValue, StatusPill } from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';
import type { WorkLoopPreview } from './MissionIntelligenceTypes';

type Mt = (key: string, fallbackEn: string) => string;

/**
 * UI-07 building blocks for the Mission Intelligence feed-style panels
 * (runtime, agent traffic, approvals): one `.kb-list` row per record instead
 * of a bordered card per record.
 */
export function FeedList({
  variant = 'plain',
  children,
}: {
  variant?: 'plain' | 'timeline';
  children: ReactNode;
}) {
  return (
    <ul className="kb-list" data-variant={variant}>
      {children}
    </ul>
  );
}

export function FeedItem({
  id,
  title,
  titleId,
  status,
  statusLabel,
  meta,
  children,
}: {
  id?: string;
  /** Human-readable title (bold line). */
  title: ReactNode;
  /** Optional machine id shown as a mono secondary line under the title. */
  titleId?: string;
  status?: KbStatus;
  statusLabel?: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li id={id} className="kb-list__item scroll-mt-6" data-status={status}>
      <div className="kb-list__body">
        <div className="chronos-mission-cell">
          <span className="kb-list__title">{title}</span>
          {titleId ? <span className="chronos-mission-cell__id">{titleId}</span> : null}
        </div>
        {meta ? <span className="kb-list__meta">{meta}</span> : null}
        {children ? <div className="mt-1 flex min-w-0 flex-col gap-2">{children}</div> : null}
      </div>
      {status ? <StatusPill status={status} label={statusLabel} /> : null}
    </li>
  );
}

/** A row of action buttons under a feed item. */
export function FeedActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function formatDateTime(ts: string | undefined | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(chronosSpeechLocale());
}

export function formatTime(ts: string | undefined | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString(chronosSpeechLocale());
}

/** Join non-empty meta fragments with a middle dot. */
export function metaLine(parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

/** The work-loop breakdown as secondary detail (collapsed by default). */
export function WorkLoopDisclosure({ workLoop, mt }: { workLoop: WorkLoopPreview; mt: Mt }) {
  return (
    <Disclosure summary={mt('chronos_mip_work_loop', 'work loop')}>
      <KeyValue
        items={[
          { label: mt('chronos_intent', 'intent'), value: workLoop.intent },
          { label: mt('chronos_mip_context', 'context'), value: workLoop.context },
          {
            label: mt('chronos_mip_resolution', 'resolution'),
            value: workLoop.resolution,
            mono: true,
          },
          { label: mt('chronos_mip_outcome', 'outcome'), value: workLoop.outcome },
          { label: mt('chronos_mip_team', 'team'), value: workLoop.team },
          { label: mt('chronos_mip_authority', 'authority'), value: workLoop.authority },
        ]}
      />
    </Disclosure>
  );
}

/** Canonical status for free-form lease / session / health strings. */
export function looseStatus(value: string | undefined | null): KbStatus {
  const normalized = String(value || '').toLowerCase();
  const map: Record<string, KbStatus> = {
    active: 'active',
    healthy: 'ready',
    completed: 'completed',
    approved: 'completed',
    promoted: 'completed',
    running: 'running',
    expired: 'stale',
    awaiting_confirmation: 'pending',
    pending: 'pending',
    proposed: 'pending',
    queued: 'pending',
    failed: 'failed',
    unhealthy: 'error',
    rejected: 'failed',
    released: 'stopped',
    closed: 'stopped',
    archived: 'archived',
    stopped: 'stopped',
  };
  return map[normalized] || 'n/a';
}

/** `status` + `statusLabel` props for a free-form value (raw text when unknown). */
export function loosePill(value: string | undefined | null): {
  status: KbStatus;
  statusLabel?: string;
} {
  const status = looseStatus(value);
  return status === 'n/a' ? { status, statusLabel: String(value || '-') } : { status };
}
