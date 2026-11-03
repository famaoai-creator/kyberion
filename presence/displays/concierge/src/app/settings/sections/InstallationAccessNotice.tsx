'use client';

import * as React from 'react';
import { Button, Callout } from '@agent/shared-ui';
import { confirmInstallationWithPasskey, passkeysSupported } from '../../../lib/passkey-client';
import type { InstallationAccessCode } from '../../../lib/installation-access-client';
import type { SettingsTranslate } from './form-scope';

/**
 * What a settings panel for installation-scope settings (this whole machine)
 * shows instead of a broken 403 state:
 *  - another member: read-only "only the installation owner can change this"
 *  - no session: sign in as the owner
 *  - the owner on another device: a passkey confirmation, then `onConfirmed`
 *    so the panel retries what it was doing.
 */
export function InstallationAccessNotice({
  code,
  t,
  onConfirmed,
}: {
  code: InstallationAccessCode;
  t: SettingsTranslate;
  onConfirmed?: () => void;
}) {
  const [state, setState] = React.useState<'idle' | 'pending' | 'done' | 'failed'>('idle');
  if (code === 'installation_owner_required') {
    return (
      <Callout
        tone="info"
        title={t('settings.installation_owner_only')}
        body={t('settings.installation_owner_only_detail')}
      />
    );
  }
  if (code === 'authentication_required') {
    return <Callout tone="warning" title={t('settings.installation_sign_in_required')} />;
  }
  const confirm = async () => {
    setState('pending');
    try {
      await confirmInstallationWithPasskey();
      setState('done');
      onConfirmed?.();
    } catch {
      setState('failed');
    }
  };
  const supported = passkeysSupported();
  return (
    <Callout
      tone="info"
      title={t('settings.installation_step_up_title')}
      body={t('settings.installation_step_up_detail')}
    >
      {supported ? (
        <Button
          label={t('settings.installation_step_up_action')}
          variant="secondary"
          disabled={state === 'pending'}
          onClick={() => void confirm()}
        />
      ) : (
        <p className="kb-text kb-text--muted">{t('settings.installation_step_up_unsupported')}</p>
      )}
      <div role="status" aria-live="polite">
        {state === 'pending' ? (
          <p className="kb-text kb-text--muted">{t('settings.installation_step_up_pending')}</p>
        ) : state === 'done' ? (
          <p className="kb-text kb-text--body">{t('settings.installation_step_up_done')}</p>
        ) : state === 'failed' ? (
          <p className="kb-text kb-text--muted">{t('settings.installation_step_up_failed')}</p>
        ) : null}
      </div>
    </Callout>
  );
}
