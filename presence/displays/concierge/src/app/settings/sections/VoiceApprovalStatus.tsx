'use client';

import * as React from 'react';
import { Button, SettingRow, TextField } from '@agent/shared-ui';
import { inboxHrefForApproval } from '../../../lib/inbox-links';
import { frontDeskFetch } from '../../../lib/front-desk-fetch';
import type { SettingsTranslate } from './form-scope';
import { asText, FormScope } from './form-scope';

const messages = {
  pending: 'authority.voice_status_pending',
  approved: 'authority.voice_status_approved',
  rejected: 'authority.voice_status_rejected',
  expired: 'authority.voice_status_expired',
  revoked: 'authority.voice_status_revoked',
} as const;

export function VoiceApprovalStatus({ t }: { t: SettingsTranslate }) {
  const [id, setId] = React.useState('');
  const [message, setMessage] = React.useState<Parameters<SettingsTranslate>[0]>();
  const [busy, setBusy] = React.useState(false);
  async function lookup() {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await frontDeskFetch(
        `/api/voice/approval-status?id=${encodeURIComponent(id.trim())}`,
        {
          cache: 'no-store',
        }
      );
      const body: unknown = await response.json();
      const status = body && typeof body === 'object' && 'status' in body ? body.status : null;
      setMessage(
        response.ok && typeof status === 'string' && Object.hasOwn(messages, status)
          ? messages[status as keyof typeof messages]
          : 'authority.voice_status_unavailable'
      );
    } catch {
      setMessage('authority.voice_status_unavailable');
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormScope
      fields={{
        'authority.voice_approval_id': (value) => {
          setId(asText(value));
          setMessage(undefined);
        },
      }}
    >
      <SettingRow label={t('authority.voice_approval_id')} control_id="voice-approval-id">
        <TextField
          id="voice-approval-id"
          name="authority.voice_approval_id"
          label={t('authority.voice_approval_id')}
          hide_label
          value={id}
          disabled={busy}
        />
        <Button
          label={t('authority.voice_status_check')}
          disabled={busy || !id.trim()}
          onClick={() => {
            void lookup();
          }}
        />
      </SettingRow>
      <p role="status">{message ? t(message) : null}</p>
      {message === 'authority.voice_status_pending' ? (
        <a
          href={inboxHrefForApproval(id.trim().toLowerCase(), {
            storageChannel: 'external-operation',
          })}
        >
          {t('authority.review')}
        </a>
      ) : null}
    </FormScope>
  );
}
