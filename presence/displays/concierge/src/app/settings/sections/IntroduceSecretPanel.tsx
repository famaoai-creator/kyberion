'use client';

import * as React from 'react';
import {
  Button,
  Callout,
  SecretField,
  Select,
  SettingRow,
  SettingsGroup,
  TextField,
} from '@agent/shared-ui';
import { applySecret, fetchSecretReadiness, proposeSecret } from '../settings-api';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

type IntroduceSecretPanelProps = {
  t: SettingsTranslate;
  services: Array<{ id: string; label: string }>;
  busy: boolean;
};

type StatusMessage = { tone: 'success' | 'danger' | 'info'; text: string } | null;
/** Outcome of the last apply, reported back to the SecretField (`status`). */
type SecretApplyStatus = { status: 'idle' | 'pending' | 'error' | 'saved'; error?: string };

/**
 * API tokens (`#secret-introduce`) — the governed two-phase secret
 * introduction: propose (no value), approval, then apply the value once.
 * The value is typed into the shared `SecretField`, which keeps it only in
 * its uncontrolled input and hands it to `onAction` on submit; this panel
 * forwards it straight into `POST /api/secrets/apply` and never keeps it in
 * state. "Set" comes from the readiness GET (`present`), never from a value.
 * The field only says "sending" after submit; this panel reports the real
 * outcome of the apply back through its `status` / `status_error` props.
 */
export function IntroduceSecretPanel({ t, services, busy }: IntroduceSecretPanelProps) {
  const [serviceId, setServiceId] = React.useState(services[0]?.id || '');
  const [secretKey, setSecretKey] = React.useState('API_KEY');
  const [reason, setReason] = React.useState('');
  const [approvalId, setApprovalId] = React.useState('');
  const [storageChannel, setStorageChannel] = React.useState('concierge');
  const [knownKeys, setKnownKeys] = React.useState<string[]>([]);
  const [present, setPresent] = React.useState<Record<string, boolean>>({});
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<StatusMessage>(null);
  const [applyStatus, setApplyStatus] = React.useState<SecretApplyStatus>({ status: 'idle' });

  React.useEffect(() => {
    if (!serviceId && services[0]?.id) setServiceId(services[0].id);
  }, [services, serviceId]);

  const refreshReadiness = React.useCallback(async (service: string) => {
    if (!service) return;
    const readiness = await fetchSecretReadiness(service);
    if (!readiness) return;
    setKnownKeys(readiness.secretKeys);
    setPresent(readiness.present);
    if (readiness.secretKeys.length) {
      setSecretKey((current) =>
        readiness.secretKeys.includes(current) ? current : readiness.secretKeys[0]
      );
    }
  }, []);

  React.useEffect(() => {
    void refreshReadiness(serviceId);
  }, [refreshReadiness, serviceId]);

  const failureText = (error: unknown) =>
    t('settings.secret_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  const fail = (error: unknown) => setMessage({ tone: 'danger', text: failureText(error) });
  const failApply = (error: unknown) => {
    fail(error);
    setApplyStatus({ status: 'error', error: failureText(error) });
  };

  const propose = async () => {
    setPending(true);
    setMessage(null);
    try {
      const result = await proposeSecret({ serviceId, secretKey, reason });
      if (!result.ok) {
        fail(result.error);
        return;
      }
      setApprovalId(result.approvalId);
      setStorageChannel(result.storageChannel);
      setMessage({
        tone: result.status === 'approved' ? 'success' : 'info',
        text: t(
          result.status === 'approved'
            ? 'settings.secret_request_approved'
            : 'settings.secret_request_pending',
          { env: result.envName }
        ),
      });
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  };

  // `value` arrives only through the SecretField's submit payload and goes
  // straight into the apply body — it is never assigned to state.
  const apply = async (value: string) => {
    if (!approvalId || !value) return;
    setPending(true);
    setMessage(null);
    setApplyStatus({ status: 'pending' });
    try {
      const result = await applySecret({ approvalId, value, storageChannel });
      if (!result.ok) {
        failApply(result.error);
        return;
      }
      setApprovalId('');
      setApplyStatus({ status: 'saved' });
      setMessage({ tone: 'success', text: t('settings.secret_applied', { env: result.envName }) });
      await refreshReadiness(serviceId);
    } catch (error) {
      failApply(error);
    } finally {
      setPending(false);
    }
  };

  const locked = busy || pending;
  const keyOptions = knownKeys.length ? knownKeys.map((key) => ({ value: key, label: key })) : null;

  return (
    <div className="settings-subsection" id="secret-introduce">
      <FormScope
        fields={{
          'secret.service': (value) => {
            setServiceId(asText(value));
            setApprovalId('');
            setMessage(null);
            setApplyStatus({ status: 'idle' });
          },
          'secret.key': (value) => {
            setSecretKey(asText(value).toUpperCase());
            setApplyStatus({ status: 'idle' });
          },
          'secret.reason': (value) => setReason(asText(value)),
          'secret.approval_id': (value) => setApprovalId(asText(value).trim()),
        }}
        actions={{
          'secret.apply': (payload) => {
            void apply(typeof payload.value === 'string' ? payload.value : '');
          },
        }}
      >
        <SettingsGroup
          id="secret-tokens"
          title={t('settings.secrets_title')}
          description={t('settings.secrets_description')}
        >
          <SettingRow label={t('settings.secret_service')}>
            <Select
              id="secret-service"
              name="secret.service"
              label={t('settings.secret_service')}
              hide_label
              value={serviceId}
              disabled={locked}
              options={services.map((service) => ({ value: service.id, label: service.label }))}
            />
          </SettingRow>
          <SettingRow label={t('settings.secret_key')}>
            {keyOptions ? (
              <Select
                id="secret-key"
                name="secret.key"
                label={t('settings.secret_key')}
                hide_label
                value={secretKey}
                disabled={locked}
                options={keyOptions}
              />
            ) : (
              <TextField
                id="secret-key"
                name="secret.key"
                label={t('settings.secret_key')}
                hide_label
                value={secretKey}
                disabled={locked}
                placeholder="API_KEY"
              />
            )}
          </SettingRow>
          <SettingRow label={t('settings.secret_reason')}>
            <TextField
              id="secret-reason"
              name="secret.reason"
              label={t('settings.secret_reason')}
              hide_label
              value={reason}
              disabled={locked}
              placeholder={t('settings.secret_reason_placeholder')}
            />
          </SettingRow>
          <SettingRow
            label={t('settings.secret_propose')}
            description={t('settings.secret_propose_description')}
          >
            <Button
              label={t('settings.secret_propose')}
              variant="secondary"
              disabled={locked || !serviceId || !secretKey}
              onClick={() => void propose()}
            />
          </SettingRow>
          <SettingRow
            label={t('settings.secret_approval_id')}
            description={t('settings.secret_approval_id_help')}
          >
            <TextField
              id="secret-approval"
              name="secret.approval_id"
              label={t('settings.secret_approval_id')}
              hide_label
              value={approvalId}
              disabled={locked}
            />
          </SettingRow>
          <div className="settings-row-block">
            <SecretField
              id="secret-value"
              name="secret.value"
              label={t('settings.secret_value')}
              help={t(approvalId ? 'settings.secret_value_help' : 'settings.secret_value_locked')}
              service_id={serviceId}
              secret_key={secretKey}
              configured={present[secretKey] === true}
              disabled={locked || !approvalId}
              action={{ id: 'secret.apply' }}
              status={applyStatus.status}
              status_error={applyStatus.error}
            />
          </div>
        </SettingsGroup>
      </FormScope>
      {message ? <Callout tone={message.tone} title={message.text} /> : null}
    </div>
  );
}
