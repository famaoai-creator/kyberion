'use client';

import * as React from 'react';
import { Disclosure, KeyValue, Section, StatusPill } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { conciergeText } from '../../lib/i18n';
import { frontDeskFetch as fetch } from '../../lib/front-desk-fetch';
import {
  parseConciergeResponseStatusResponse,
  type ConciergeResponseStatus,
} from '../../lib/concierge-advisory-response';
import { ReviewCheckin } from '../review-checkin';

/**
 * The advisory panels that sat under the old `/` decision queue, kept on
 * `/inbox` (MSN-SHELL-IA): the read-only self check-in and the bounded
 * response-waiting status (`/api/response-status`). Both are advisory — a
 * failed read hides the panel and never blocks the queue.
 */

const RESPONSE_STATUS_POLL_MS = 10_000;

export function ResponseStatusPanel() {
  const { t } = useConciergeI18n();
  const [status, setStatus] = React.useState<ConciergeResponseStatus | null>(null);

  React.useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const response = await fetch('/api/response-status', { cache: 'no-store' });
        const parsed = parseConciergeResponseStatusResponse(
          await response.json().catch(() => null)
        );
        if (!response.ok || !parsed) throw new Error('response-status');
        if (active) setStatus(parsed);
      } catch {
        // Advisory: the queue stays usable without it.
      }
    };
    void read();
    const timer = setInterval(() => void read(), RESPONSE_STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (!status) return null;
  const pill =
    status.state === 'ready' ? 'ready' : status.state === 'waiting' ? 'working' : 'pending';
  return (
    <Section title={t('home.response_title')} description={t('home.response_description')}>
      <div className="response-status-line">
        <StatusPill status={pill} label={status.label} />
        <span className="decide-muted">{status.next_action}</span>
      </div>
      {status.active_tasks.length > 0 ? (
        <KeyValue
          items={status.active_tasks.map((task) => ({
            label: t('home.response_task', { value: task.task_id || task.delegation_id }),
            value: [
              task.backend_name ? t('home.response_backend', { value: task.backend_name }) : '',
              t('home.response_elapsed', { value: task.elapsed_seconds }),
            ]
              .filter(Boolean)
              .join(' · '),
          }))}
        />
      ) : null}
      {status.stale_child_count > 0 ? (
        <p className="decide-muted">
          {t('home.response_stale', { count: status.stale_child_count })}
        </p>
      ) : null}
    </Section>
  );
}

/** The self check-in, for the company the server narrowed this view to (else all). */
export function InboxCheckin() {
  const { locale } = useConciergeI18n();
  const [tenant, setTenant] = React.useState('all');
  React.useEffect(() => {
    let active = true;
    fetch('/api/me')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const selection = (data as { selection?: Record<string, unknown> } | null)?.selection;
        if (active && selection?.mode === 'tenant' && typeof selection.tenant_slug === 'string')
          setTenant(selection.tenant_slug);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <Disclosure summary={conciergeText('ux_a_checkin_summary', locale)}>
      <ReviewCheckin key={tenant} tenant={tenant} />
    </Disclosure>
  );
}
