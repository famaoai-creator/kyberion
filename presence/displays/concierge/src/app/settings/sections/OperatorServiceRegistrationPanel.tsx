'use client';

import * as React from 'react';
import { Badge, Button, Callout, SecretField, SettingsGroup } from '@agent/shared-ui';
import {
  applyOperatorService,
  checkOperatorApproval,
  createOperatorRequestGuard,
  fetchOperatorServices,
  probeOperatorService,
  proposeOperatorService,
  type OperatorError,
  type OperatorProbe,
  type OperatorProbeStatus,
  type OperatorServiceDescriptor,
} from '../operator-services-api';
import { FormScope, type SettingsTranslate } from './form-scope';
import type { ConciergeMessageKey } from '../../../lib/i18n';

const errorKeys: Record<OperatorError, ConciergeMessageKey> = {
  local_operator_required: 'settings.operator_local_required',
  invalid_request: 'settings.operator_invalid_request',
  approval_required: 'settings.operator_approval_required',
  recovery_required: 'settings.operator_recovery_required',
  unavailable: 'settings.operator_unavailable',
};
const probeKeys: Record<OperatorProbeStatus, ConciergeMessageKey> = {
  authenticated: 'settings.operator_authenticated',
  credential_missing: 'settings.operator_credential_missing',
  credential_shadowed: 'settings.operator_credential_shadowed',
  authentication_failed: 'settings.operator_authentication_failed',
  unavailable: 'settings.operator_probe_unavailable',
  unsupported: 'settings.operator_probe_unsupported',
};

/** Metadata is fetched anew on mount: presence never resurrects an old green authentication result. */
export function OperatorServiceRegistrationPanel({ t }: { t: SettingsTranslate }) {
  const [services, setServices] = React.useState<OperatorServiceDescriptor[] | null>(null);
  const [error, setError] = React.useState<OperatorError | null>(null);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setServices(null);
    setError(null);
    void fetchOperatorServices(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setServices(result.services);
      else setError(result.error);
    });
    return () => controller.abort();
  }, [revision]);

  return (
    <div className="settings-subsection" id="operator-service-registration">
      <SettingsGroup
        id="operator-services"
        title={t('settings.operator_title')}
        description={t('settings.operator_description')}
      >
        <div className="settings-row-block">
          <p className="kb-text kb-text--muted">{t('settings.operator_independent')}</p>
          <p className="kb-text kb-text--caption">{t('settings.operator_unsupported_providers')}</p>
        </div>
        {error ? (
          <div className="settings-row-block">
            <Callout tone="warning" title={t(errorKeys[error])} />
            <Button
              label={t('settings.operator_reload')}
              variant="secondary"
              onClick={() => setRevision((value) => value + 1)}
            />
          </div>
        ) : services === null ? (
          <p className="settings-row-block kb-text kb-text--muted" role="status">
            {t('settings.operator_loading')}
          </p>
        ) : services.length === 0 ? (
          <p className="settings-row-block kb-text kb-text--muted">
            {t('settings.operator_empty')}
          </p>
        ) : (
          services.map((service) => (
            <OperatorServiceCard key={service.serviceId} service={service} t={t} />
          ))
        )}
      </SettingsGroup>
    </div>
  );
}

type Activity = 'idle' | 'preparing' | 'applying' | 'probing';
type Review = { approvalId: string; status: 'approved' | 'pending' } | null;

/** One mounted card owns one immutable service identity and its short-lived approval. */
function OperatorServiceCard({
  service,
  t,
}: {
  service: OperatorServiceDescriptor;
  t: SettingsTranslate;
}) {
  const [registered, setRegistered] = React.useState(service.credential_present);
  const [activity, setActivity] = React.useState<Activity>('idle');
  const [review, setReview] = React.useState<Review>(null);
  const [error, setError] = React.useState<OperatorError | null>(null);
  const [probe, setProbe] = React.useState<OperatorProbe | null>(null);
  const [saved, setSaved] = React.useState(false);
  const guard = React.useRef(createOperatorRequestGuard());
  const applying = React.useRef(false);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const requests = guard.current;
    return () => requests.cancel();
  }, []);

  // Clear even a detached, cancelled input. Only the DOM node is retained;
  // its token value is never read by this cleanup or copied anywhere.
  React.useEffect(() => {
    const input = cardRef.current?.querySelector<HTMLInputElement>('input.kb-secret-field__input');
    return () => {
      if (input) input.value = '';
    };
  }, [review?.approvalId, review?.status]);

  const prepare = async () => {
    const request = guard.current.begin();
    if (!request) return;
    setActivity('preparing');
    setReview(null);
    setError(null);
    setSaved(false);
    const result = await proposeOperatorService(service.serviceId, request.signal);
    if (!request.current()) return;
    if (result.ok) setReview({ approvalId: result.approvalId, status: result.status });
    else setError(result.error);
    setActivity('idle');
    request.finish();
  };

  const cancel = () => {
    // An apply already sent cannot be undone. Its cancel control is disabled.
    if (applying.current || activity === 'probing') return;
    const input = cardRef.current?.querySelector<HTMLInputElement>('input.kb-secret-field__input');
    if (input) input.value = '';
    guard.current.cancel();
    setReview(null);
    setActivity('idle');
    setError(null);
  };

  const checkApproval = async () => {
    if (!review || review.status !== 'pending') return;
    const request = guard.current.begin();
    if (!request) return;
    setActivity('preparing');
    setError(null);
    const result = await checkOperatorApproval(
      service.serviceId,
      review.approvalId,
      request.signal
    );
    if (!request.current()) return;
    if (result.ok) setReview({ approvalId: result.approvalId, status: result.status });
    else {
      setError(result.error);
      if (result.error === 'approval_required' || result.error === 'recovery_required')
        setReview(null);
    }
    setActivity('idle');
    request.finish();
  };

  const verify = async () => {
    const request = guard.current.begin();
    if (!request) return;
    setActivity('probing');
    setError(null);
    setProbe(null);
    const result = await probeOperatorService(service.serviceId, request.signal);
    if (!request.current()) return;
    if (result.ok) {
      setProbe(result);
      if (result.status === 'credential_missing') setRegistered(false);
    } else setError(result.error);
    setActivity('idle');
    request.finish();
  };

  // SecretField clears its uncontrolled input before dispatch. The token is
  // forwarded once to apply, never copied into React state, refs, or storage.
  const apply = async (value: string) => {
    if (!value || review?.status !== 'approved') return;
    const request = guard.current.begin();
    if (!request) return;
    const approvalId = review.approvalId;
    applying.current = true;
    // Unmount the collector immediately so a late clipboard promise cannot
    // refill a submitted input while registration is in flight.
    setReview(null);
    setActivity('applying');
    setError(null);
    setProbe(null);
    setSaved(false);
    const result = await applyOperatorService(service.serviceId, approvalId, value, request.signal);
    if (!request.current()) return;
    applying.current = false;
    setReview(null);
    if (!result.ok) {
      setError(result.error);
      setActivity('idle');
      request.finish();
      return;
    }
    setRegistered(true);
    setSaved(true);
    setActivity('probing');
    const checked = await probeOperatorService(service.serviceId, request.signal);
    if (!request.current()) return;
    if (checked.ok) {
      setProbe(checked);
      if (checked.status === 'credential_missing') setRegistered(false);
    } else setError(checked.error);
    setActivity('idle');
    request.finish();
  };

  const busy = activity !== 'idle';
  const authenticated = probe?.status === 'authenticated';
  const statusKey = authenticated
    ? 'settings.operator_authenticated'
    : registered
      ? 'settings.operator_registered_unverified'
      : 'settings.operator_not_registered';
  return (
    <div ref={cardRef} className="settings-row-block" data-operator-service={service.serviceId}>
      <h3 className="kb-text kb-text--body">{service.label}</h3>
      <Badge label={t(statusKey)} tone={authenticated ? 'success' : 'neutral'} />
      <p className="kb-text kb-text--muted">{service.scopeNotice}</p>
      <p className="kb-text kb-text--caption">{t('settings.operator_scope_limit')}</p>
      <p className="kb-text kb-text--caption">
        {t('settings.operator_auth_operation', { operation: service.authOperation })}
      </p>
      <p className="kb-text kb-text--body">
        <a
          href={service.setupUrl}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {t('settings.operator_issue_token', { service: service.label })}
        </a>
      </p>
      <div className="settings-row-actions">
        <Button
          label={t(registered ? 'settings.operator_prepare_replace' : 'settings.operator_prepare')}
          variant="secondary"
          disabled={busy || review !== null}
          onClick={() => void prepare()}
        />
        {review?.status === 'pending' ? (
          <Button
            label={t('settings.operator_check_approval')}
            variant="secondary"
            disabled={busy}
            onClick={() => void checkApproval()}
          />
        ) : null}
        {registered ? (
          <Button
            label={t('settings.operator_verify')}
            variant="secondary"
            disabled={busy || review !== null}
            onClick={() => void verify()}
          />
        ) : null}
        {review || activity === 'preparing' ? (
          <Button
            label={t('settings.operator_cancel')}
            variant="ghost"
            disabled={activity === 'applying' || activity === 'probing'}
            onClick={cancel}
          />
        ) : null}
      </div>
      {review?.status === 'pending' ? (
        <Callout tone="info" title={t('settings.operator_pending')} />
      ) : null}
      {review?.status === 'approved' ? (
        <FormScope
          actions={{
            'operator.token.apply': (payload) => {
              if (payload.service_id === service.serviceId)
                void apply(typeof payload.value === 'string' ? payload.value : '');
            },
          }}
        >
          <p className="kb-text kb-text--muted">
            {t('settings.operator_review', { service: service.label })}
          </p>
          <SecretField
            key={review.approvalId}
            id={'operator-token-' + service.serviceId}
            name={'operator.token.' + service.serviceId}
            label={t('settings.operator_token_label', { service: service.label })}
            help={t('settings.operator_token_help')}
            service_id={service.serviceId}
            secret_key={service.secretKey}
            configured={false}
            disabled={busy}
            action={{ id: 'operator.token.apply' }}
            status={activity === 'applying' ? 'pending' : 'idle'}
          />
        </FormScope>
      ) : null}
      <div role="status" aria-live="polite">
        {activity !== 'idle' ? (
          <p className="kb-text kb-text--muted">
            {t(
              activity === 'preparing'
                ? 'settings.operator_preparing'
                : activity === 'applying'
                  ? 'settings.operator_applying'
                  : 'settings.operator_probing'
            )}
          </p>
        ) : null}
        {saved ? <p className="kb-text kb-text--body">{t('settings.operator_saved')}</p> : null}
        {probe ? (
          <Callout
            tone={authenticated ? 'success' : 'warning'}
            title={t(probeKeys[probe.status])}
          />
        ) : null}
        {probe ? (
          <p className="kb-text kb-text--caption">
            {t('settings.operator_checked_at', { time: probe.checkedAt })}
          </p>
        ) : null}
        {error ? <Callout tone="danger" title={t(errorKeys[error])} /> : null}
        {authenticated ? (
          <div className="settings-row-block">
            <p className="kb-text kb-text--muted">
              {t('settings.operator_next_step', { service: service.label })}
            </p>
            <a href="/">{t('settings.operator_open_requests')}</a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
