'use client';

import * as React from 'react';
import { Button, Callout, Dialog, SettingRow, StatusPill, TalkingAvatar } from '@agent/shared-ui';
import { FormScope, type SettingsTranslate } from './form-scope';

/**
 * PA-10 "create an avatar from this photo" (settings → 写真・音声). Flow:
 * button → consent `ui:dialog` naming the provider the server planned and
 * what is sent (cancel = nothing sent) → `POST /api/setup`
 * `action: 'avatar_generate'` (async job) → poll `GET
 * /api/setup/avatar-generation?job=` → preview of the generated set (served
 * only through the authenticated `/api/me/avatar/:expression`) → "Use this
 * avatar" (`action: 'avatar_use'`, sets `identity.avatar_profile`).
 */
type Plan = {
  provider_id: string;
  display_name: string;
  data_egress: 'local' | 'cloud';
  interactive_handoff: boolean;
};
type AvatarWire = {
  images: Record<string, string> & { neutral: string };
  mouth: { x: number; y: number; width: number };
  generated_at: string;
  adopted: boolean;
};
type Job = {
  id: string;
  status: 'running' | 'succeeded' | 'handoff' | 'failed';
  reason?: 'consent_denied' | 'no_provider' | 'generation_failed';
  handoff_manifest?: string;
};
type Overview = { photo_available: boolean; plan: Plan | null; avatar: AvatarWire | null };

const PREVIEW_ORDER = [
  'neutral',
  'joy',
  'thinking',
  'listening',
  'speaking',
  'mouth_open',
] as const;
const EXPRESSION_LABEL = {
  neutral: 'setup.avatar_expression_neutral',
  joy: 'setup.avatar_expression_joy',
  thinking: 'setup.avatar_expression_thinking',
  listening: 'setup.avatar_expression_listening',
  speaking: 'setup.avatar_expression_speaking',
  mouth_open: 'setup.avatar_expression_mouth_open',
} as const;
const POLL_MS = 3000;

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const body = (await response.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

export function AvatarGenerationPanel({
  t,
  busy,
  photoVersion,
}: {
  t: SettingsTranslate;
  busy: boolean;
  /** Changes whenever the registered photo changes, to refresh the plan. */
  photoVersion: string;
}) {
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [job, setJob] = React.useState<Job | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/setup/avatar-generation', { cache: 'no-store' });
      const body = await readJson(response);
      if (!response.ok || !body) return;
      setOverview({
        photo_available: body.photo_available === true,
        plan: (body.plan as Plan | null) ?? null,
        avatar: (body.avatar as AvatarWire | null) ?? null,
      });
      const running = body.running_job as Job | null | undefined;
      if (running?.status === 'running') setJob(running);
    } catch {
      /* the panel stays in its initial state; the rest of settings still works */
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load, photoVersion]);

  const plan = overview?.plan ?? null;
  const provider = plan?.display_name ?? '';

  const finish = React.useCallback(
    (done: Job) => {
      if (done.status === 'succeeded') {
        setNotice({ text: t('setup.avatar_generate_done') });
      } else if (done.status === 'handoff') {
        setNotice({
          text: t('setup.avatar_generate_handoff', {
            provider,
            path: done.handoff_manifest ?? '',
          }),
        });
      } else {
        setNotice({
          text:
            done.reason === 'consent_denied'
              ? t('setup.avatar_generate_denied')
              : done.reason === 'no_provider'
                ? t('setup.avatar_generate_no_provider')
                : t('setup.avatar_generate_failed'),
          error: true,
        });
      }
      void load();
    },
    [load, provider, t]
  );

  React.useEffect(() => {
    if (job?.status !== 'running') return undefined;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(
          `/api/setup/avatar-generation?job=${encodeURIComponent(job.id)}`,
          { cache: 'no-store' }
        );
        const body = await readJson(response);
        const next = body?.job as Job | undefined;
        if (!response.ok || !next) {
          setJob(null);
          setNotice({ text: t('setup.avatar_generate_failed'), error: true });
          return;
        }
        if (next.status !== 'running') {
          setJob(next);
          finish(next);
        }
      } catch {
        /* keep polling; a transient network error is not a job failure */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [finish, job, t]);

  const start = React.useCallback(async () => {
    setDialogOpen(false);
    if (!plan) return;
    setNotice({ text: t('setup.avatar_generate_running') });
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'avatar_generate',
          consent: { provider_id: plan.provider_id, confirmed: true },
        }),
      });
      const body = await readJson(response);
      const started = body?.job as Job | undefined;
      if (started) setJob(started);
      if (!response.ok) {
        setNotice({
          text: typeof body?.error === 'string' ? body.error : t('setup.avatar_generate_failed'),
          error: true,
        });
      }
    } catch {
      setNotice({ text: t('setup.avatar_generate_failed'), error: true });
    }
  }, [plan, t]);

  const adopt = React.useCallback(async () => {
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'avatar_use' }),
      });
      if (!response.ok) throw new Error('avatar_use failed');
      setNotice({ text: t('setup.avatar_used') });
      await load();
    } catch {
      setNotice({ text: t('setup.avatar_generate_failed'), error: true });
    }
  }, [load, t]);

  const running = job?.status === 'running';
  const avatar = overview?.avatar ?? null;
  const version = encodeURIComponent(avatar?.generated_at ?? '');
  const withVersion = (url: string) => `${url}?v=${version}`;
  const consentMessage = !plan
    ? ''
    : plan.data_egress === 'local'
      ? t('setup.avatar_consent_local', { provider })
      : plan.interactive_handoff
        ? t('setup.avatar_consent_handoff', { provider })
        : t('setup.avatar_consent_cloud', { provider });
  const description = !overview?.photo_available
    ? t('setup.avatar_generate_needs_photo')
    : !plan
      ? t('setup.avatar_generate_no_provider')
      : t('setup.avatar_generate_description');

  return (
    <FormScope
      actions={{
        'avatar.generate.confirm': () => void start(),
        'avatar.generate.cancel': () => setDialogOpen(false),
      }}
    >
      <SettingRow label={t('setup.avatar_generate_title')} description={description}>
        <Button
          label={t('setup.avatar_generate_button')}
          variant="secondary"
          disabled={busy || running || !overview?.photo_available || !plan}
          onClick={() => setDialogOpen(true)}
        />
      </SettingRow>
      {notice ? (
        <div className="settings-row-block" role="status" aria-live="polite">
          <Callout tone={notice.error ? 'danger' : 'info'} title={notice.text} />
        </div>
      ) : null}
      {avatar ? (
        <div className="settings-row-block">
          <SettingRow label={t('setup.avatar_preview_title')}>
            {avatar.adopted ? (
              <StatusPill status="completed" label={t('setup.avatar_in_use')} />
            ) : (
              <Button
                label={t('setup.avatar_use')}
                variant="primary"
                disabled={busy || running}
                onClick={() => void adopt()}
              />
            )}
          </SettingRow>
          <TalkingAvatar
            name="generated-avatar-preview"
            label={t('setup.avatar_preview_title')}
            images={
              Object.fromEntries(
                Object.entries(avatar.images).map(([key, url]) => [key, withVersion(url)])
              ) as AvatarWire['images']
            }
            mouth={avatar.mouth}
            size="lg"
          />
          <ul className="avatar-generation-grid" aria-label={t('setup.avatar_preview_title')}>
            {PREVIEW_ORDER.filter((expression) => avatar.images[expression]).map((expression) => (
              <li key={expression}>
                <img
                  src={withVersion(avatar.images[expression]!)}
                  alt={t(EXPRESSION_LABEL[expression])}
                  width={96}
                  height={96}
                />
                <span className="kb-text kb-text--muted">{t(EXPRESSION_LABEL[expression])}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Dialog
        id="avatar-generate-consent"
        open={dialogOpen}
        title={t('setup.avatar_consent_title')}
        message={consentMessage}
        confirm_label={
          plan?.data_egress === 'local'
            ? t('setup.avatar_consent_confirm_local')
            : t('setup.avatar_consent_confirm')
        }
        action={{ id: 'avatar.generate.confirm' }}
        cancel_action={{ id: 'avatar.generate.cancel' }}
      />
    </FormScope>
  );
}
