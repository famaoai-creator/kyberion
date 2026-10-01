'use client';

import * as React from 'react';
import { Button, SettingsGroup } from '@agent/shared-ui';
import {
  parsePushStatus,
  pushSupport,
  urlBase64ToBytes,
  type PushStatusResponse,
} from '../../../lib/push-client';
import type { SettingsTranslate } from './form-scope';

type Message = { text: string; error?: boolean } | null;

/**
 * 通知設定 › この端末に通知する. Subscribes THIS browser to Web Push. The
 * notification itself says only that something is waiting — never what.
 */
export function PushPane({ t }: { t: SettingsTranslate }) {
  const [status, setStatus] = React.useState<PushStatusResponse | null>(null);
  const [operatorEligible, setOperatorEligible] = React.useState(false);
  const [deviceOn, setDeviceOn] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<Message>(null);

  const supported =
    typeof window !== 'undefined' &&
    pushSupport({
      hasWindow: true,
      secure: window.isSecureContext,
      hasServiceWorker: 'serviceWorker' in navigator,
      hasPushManager: 'PushManager' in window,
      hasNotification: 'Notification' in window,
    }) === 'supported';

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/push', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      const parsed = parsePushStatus(payload);
      if (response.ok && parsed) {
        setStatus(parsed);
        setOperatorEligible(
          Boolean(
            payload &&
            typeof payload === 'object' &&
            (payload as Record<string, unknown>).operator_eligible === true
          )
        );
      }
      if (supported) {
        const registration = await navigator.serviceWorker.getRegistration('/');
        setDeviceOn(Boolean(await registration?.pushManager.getSubscription()));
      }
    } catch {
      // The pane stays hidden; push is best-effort.
    }
  }, [supported]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const fail = (detail: string) =>
    setMessage({ text: t('setup.push_err', { detail }), error: true });

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !data || data.ok !== true) {
      throw new Error(String(data?.error ?? response.status));
    }
  };

  const turnOn = async () => {
    if (!status?.public_key) return;
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setMessage({ text: t('setup.push_denied'), error: true });
        return;
      }
      const registration =
        (await navigator.serviceWorker.getRegistration('/')) ??
        (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBytes(status.public_key) as BufferSource,
        }));
      await post({ action: 'subscribe', subscription: subscription.toJSON() });
      setMessage({ text: t('setup.push_enabled') });
      await load();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await post({ action: 'unsubscribe', endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setMessage({ text: t('setup.push_disabled') });
      await load();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  return (
    <SettingsGroup
      id="settings-push"
      title={t('setup.push_title')}
      description={t('setup.push_description')}
    >
      {!supported ? (
        <p role="status">{t('setup.push_unsupported')}</p>
      ) : !operatorEligible ? (
        <>
          <p role="status">{t('setup.push_description')}</p>
          {deviceOn ? (
            <div className="settings-row-actions">
              <Button
                label={t('setup.push_off')}
                variant="secondary"
                disabled={busy}
                onClick={() => void turnOff()}
              />
            </div>
          ) : null}
        </>
      ) : !status.configured ? (
        <p role="status">{t('setup.push_unconfigured')}</p>
      ) : (
        <div className="settings-row-actions">
          <Button
            label={deviceOn ? t('setup.push_off') : t('setup.push_on')}
            variant={deviceOn ? 'secondary' : 'primary'}
            disabled={busy}
            onClick={() => void (deviceOn ? turnOff() : turnOn())}
          />
        </div>
      )}
      {message ? <p role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
    </SettingsGroup>
  );
}
