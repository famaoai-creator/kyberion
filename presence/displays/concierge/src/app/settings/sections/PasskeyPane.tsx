'use client';

import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';

import * as React from 'react';
import { Button, SettingsGroup } from '@agent/shared-ui';
import {
  parsePasskeyList,
  passkeyCoolingDown,
  passkeysSupported,
  registerPasskey,
  revokePasskey,
  type PasskeySummary,
} from '../../../lib/passkey-client';
import type { SettingsTranslate } from './form-scope';

type Message = { text: string; error?: boolean } | null;

/**
 * プロフィール › パスキー. Registers this member's passkeys; approvals that
 * require A3 (secrets, policy changes, project trust) are signed with one.
 * Once a usable passkey exists, adding or removing one is confirmed with it;
 * a passkey added without that confirmation waits out the enrollment cooldown.
 */
export function PasskeyPane({ t }: { t: SettingsTranslate }) {
  const [passkeys, setPasskeys] = React.useState<PasskeySummary[] | null>(null);
  const [stepUp, setStepUp] = React.useState(false);
  const [label, setLabel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<Message>(null);
  const supported = passkeysSupported();

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/me/passkeys', { cache: 'no-store' });
      const parsed = parsePasskeyList(await response.json().catch(() => null));
      setPasskeys(response.ok && parsed?.member ? parsed.passkeys : null);
      setStepUp(Boolean(parsed?.stepUpRequired));
    } catch {
      setPasskeys(null);
      setStepUp(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: done });
      await load();
    } catch (error) {
      setMessage({
        text: t('setup.passkey_err', {
          detail: error instanceof Error ? error.message : String(error),
        }),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!passkeys) return null;
  return (
    <SettingsGroup
      id="settings-passkeys"
      title={t('setup.passkey_title')}
      description={t('setup.passkey_description')}
    >
      {passkeys.length === 0 ? (
        <p>{t('setup.passkey_none')}</p>
      ) : (
        <ul className="settings-row-block">
          {passkeys.map((passkey) => (
            <li key={passkey.credential_id} className="settings-inline-actions">
              <span>
                {passkey.label} · {passkey.created_at.slice(0, 10)}
                {passkeyCoolingDown(passkey) && passkey.usable_after
                  ? ` · ${t('setup.passkey_cooling', {
                      when: new Date(passkey.usable_after).toLocaleString(),
                    })}`
                  : null}
              </span>
              <Button
                label={t('setup.passkey_revoke')}
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => revokePasskey(passkey.credential_id, { stepUp }),
                    t('setup.passkey_revoked')
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
      {supported && stepUp ? <p>{t('setup.passkey_step_up_hint')}</p> : null}
      {supported ? (
        <div className="settings-row-actions">
          <input
            type="text"
            value={label}
            maxLength={64}
            aria-label={t('setup.passkey_label')}
            placeholder={t('setup.passkey_label')}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button
            label={t('setup.passkey_add')}
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await registerPasskey(label.trim(), { stepUp });
                setLabel('');
              }, t('setup.passkey_added'))
            }
          />
        </div>
      ) : (
        <p role="status">{t('setup.passkey_unsupported')}</p>
      )}
      {message ? <p role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
    </SettingsGroup>
  );
}
