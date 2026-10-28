'use client';

import * as React from 'react';
import { Button } from '@agent/shared-ui';
import type { SettingsTranslate } from './form-scope';

export interface OAuthOperationHandle {
  operationId: string;
  serviceId: string;
  label: string;
  expiresAt: string;
}
type Status = 'waiting' | 'confirming' | 'connected' | 'failed' | 'expired' | 'unavailable';

/** Dismissing this view never cancels consent or changes credentials. */
export function OAuthOperationCard({
  operation,
  t,
  onDismiss,
}: {
  operation: OAuthOperationHandle;
  t: SettingsTranslate;
  onDismiss: () => void;
}) {
  const [status, setStatus] = React.useState<Status>('waiting');
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async () => {
      let terminal = false;
      const request = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: (error: Error) => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const cancel = () => {
        request.abort();
        rejectAbort(new Error('observation cancelled'));
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      deadline = setTimeout(cancel, 10_000);
      try {
        const query = new URLSearchParams({
          service_id: operation.serviceId,
          operation_id: operation.operationId,
        });
        const { response, body } = await Promise.race([
          fetch(`/api/oauth/operation?${query}`, {
            cache: 'no-store',
            signal: request.signal,
          }).then(async (response) => ({ response, body: await response.json() })),
          aborted,
        ]);
        if (controller.signal.aborted) return;
        if (request.signal.aborted) throw new Error('observation expired');
        const observed = body?.operation;
        if (
          !response.ok ||
          !body?.ok ||
          observed?.operationId !== operation.operationId ||
          observed?.serviceId !== operation.serviceId ||
          !['waiting', 'confirming', 'connected', 'failed', 'expired'].includes(observed?.status)
        )
          throw new Error('unavailable');
        setStatus(observed.status);
        terminal = ['connected', 'failed', 'expired'].includes(observed.status);
      } catch {
        if (!controller.signal.aborted) setStatus('unavailable');
      } finally {
        if (deadline) clearTimeout(deadline);
        controller.signal.removeEventListener('abort', cancel);
      }
      // A failed observation never proves completion or expiry. Bound retries
      // to this initiation lifetime; a dismissed/replaced card cannot revive.
      if (!controller.signal.aborted && !terminal && ++attempts < 480)
        timer = setTimeout(() => void poll(), 1500);
    };
    setStatus('waiting');
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [operation.operationId, operation.serviceId]);
  const labels: Record<Status, string> = {
    waiting: t('setup.oauth_operation_waiting'),
    confirming: t('setup.oauth_operation_confirming'),
    connected: t('setup.oauth_operation_connected'),
    failed: t('setup.oauth_operation_failed'),
    expired: t('setup.oauth_operation_expired'),
    unavailable: t('setup.oauth_operation_unavailable'),
  };
  return (
    <section aria-label={t('setup.oauth_operation_title')}>
      <p role={status === 'failed' || status === 'unavailable' ? 'alert' : 'status'}>
        {operation.label}: {labels[status]}
      </p>
      <p>{t('setup.oauth_operation_dismiss_hint')}</p>
      <Button label={t('setup.oauth_operation_dismiss')} onClick={onDismiss} />
    </section>
  );
}
