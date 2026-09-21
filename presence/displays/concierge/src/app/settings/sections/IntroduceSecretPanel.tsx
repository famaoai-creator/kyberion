'use client';

import * as React from 'react';

type IntroduceSecretPanelProps = {
  services: Array<{ id: string; label: string }>;
  busy: boolean;
};

type StatusMessage = { tone: 'ok' | 'error' | 'info'; text: string } | null;

/**
 * Concierge Introduce Secret — two-phase: propose (no value) then apply (password input).
 * Values are never echoed back from the API responses rendered here.
 */
export function IntroduceSecretPanel({ services, busy }: IntroduceSecretPanelProps) {
  const [serviceId, setServiceId] = React.useState(services[0]?.id || '');
  const [secretKey, setSecretKey] = React.useState('API_KEY');
  const [reason, setReason] = React.useState('');
  const [approvalId, setApprovalId] = React.useState('');
  const [storageChannel, setStorageChannel] = React.useState('concierge');
  const [secretValue, setSecretValue] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<StatusMessage>(null);

  React.useEffect(() => {
    if (!serviceId && services[0]?.id) setServiceId(services[0].id);
  }, [services, serviceId]);

  const propose = async () => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/secrets/introduce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceId,
          secretKey,
          reason: reason || `Introduce ${serviceId} ${secretKey}`,
          autoApprove: true,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        approvalId?: string;
        status?: string;
        envName?: string;
        storageChannel?: string;
        next?: string;
      };
      if (!response.ok || !payload.ok) {
        setMessage({ tone: 'error', text: payload.error || 'Propose failed' });
        return;
      }
      setApprovalId(payload.approvalId || '');
      setStorageChannel(payload.storageChannel || 'concierge');
      setMessage({
        tone: 'ok',
        text: `Request ${payload.status}: ${payload.envName}. ${
          payload.status === 'approved'
            ? 'Paste the secret below to apply.'
            : payload.next || 'Awaiting approval.'
        }`,
      });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  };

  const apply = async () => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/secrets/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          approvalId,
          value: secretValue,
          storageChannel,
          channel: storageChannel,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        status?: string;
        envName?: string;
      };
      if (!response.ok || !payload.ok) {
        setMessage({ tone: 'error', text: payload.error || 'Apply failed' });
        return;
      }
      setSecretValue('');
      setMessage({
        tone: 'ok',
        text: `Applied ${payload.envName} (${payload.status}). Value not retained in UI.`,
      });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="pane"
      id="secret-introduce"
      aria-label="Introduce secret"
      style={{ marginTop: '1.5rem' }}
    >
      <h3 className="pane-subheading">Introduce secret</h3>
      <p className="pane-subtitle">
        Propose a governed secret mutation without pasting into CLI argv, then apply the value after
        approval. The value never appears in Chronos review payloads.
      </p>
      <div className="button-row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <label>
          Service
          <select
            value={serviceId}
            disabled={busy || pending}
            onChange={(event) => setServiceId(event.target.value)}
          >
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Secret key
          <input
            type="text"
            value={secretKey}
            disabled={busy || pending}
            onChange={(event) => setSecretKey(event.target.value.toUpperCase())}
            placeholder="API_KEY"
          />
        </label>
        <label style={{ flex: '1 1 12rem' }}>
          Reason
          <input
            type="text"
            value={reason}
            disabled={busy || pending}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this credential is needed"
          />
        </label>
        <button
          type="button"
          className="action-button"
          disabled={busy || pending || !serviceId || !secretKey}
          onClick={() => void propose()}
        >
          Submit request
        </button>
      </div>
      <div
        className="button-row"
        style={{ flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.75rem' }}
      >
        <label style={{ flex: '1 1 14rem' }}>
          Approval id
          <input
            type="text"
            value={approvalId}
            disabled={busy || pending}
            onChange={(event) => setApprovalId(event.target.value)}
            placeholder="filled after propose"
          />
        </label>
        <label style={{ flex: '1 1 14rem' }}>
          Secret value
          <input
            type="password"
            value={secretValue}
            disabled={busy || pending || !approvalId}
            onChange={(event) => setSecretValue(event.target.value)}
            placeholder="paste once after approval"
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          className="action-button secondary"
          disabled={busy || pending || !approvalId || !secretValue}
          onClick={() => void apply()}
        >
          Apply secret
        </button>
      </div>
      {message ? (
        <p className="item-meta" data-tone={message.tone}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
