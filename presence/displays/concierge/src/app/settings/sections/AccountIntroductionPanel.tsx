'use client';

import * as React from 'react';
import { Button, Callout } from '@agent/shared-ui';
import { frontDeskFetch } from '../../../lib/front-desk-fetch';
import type { SettingsTranslate } from './form-scope';

type Preview = {
  binding_id: string;
  service_id: string;
  secret_refs: string[];
  statement: string;
  digest: string;
  expected_generation: string | null;
};
type Pending = { approval_id: string; approval_url: string; can_apply: boolean };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A connection-bound collector. Values exist only after the server confirms approval. */
export function AccountIntroductionPanel({
  bindingId,
  t,
}: {
  bindingId: string;
  t: SettingsTranslate;
}) {
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<'error' | 'saved' | 'recovery' | null>(null);
  const sequence = React.useRef(0);
  const inFlight = React.useRef(false);
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    sequence.current += 1;
    controller.current?.abort();
    inFlight.current = false;
    setBusy(false);
    setPreview(null);
    setPending(null);
    setValues({});
    setMessage(null);
    return () => {
      sequence.current += 1;
      controller.current?.abort();
    };
  }, [bindingId]);

  const run = async (action: 'preview' | 'request' | 'status' | 'apply') => {
    if (inFlight.current) return;
    if (action !== 'preview' && (!preview || preview.binding_id !== bindingId)) return;
    if ((action === 'status' || action === 'apply') && !pending) return;
    if (
      action === 'apply' &&
      (!pending?.can_apply || preview!.secret_refs.some((key) => !values[key]))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const ticket = ++sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    const body = {
      action,
      binding_id: bindingId,
      ...(action === 'request'
        ? {
            digest: preview!.digest,
            expected_generation: preview!.expected_generation,
          }
        : {}),
      ...(action === 'status' || action === 'apply' ? { approval_id: pending!.approval_id } : {}),
      ...(action === 'apply' ? { material: values } : {}),
    };
    // Clear before awaiting transport; an uncertain result never keeps a reusable token form.
    if (action === 'apply') {
      setValues({});
      setPending((old) => (old ? { ...old, can_apply: false } : null));
    }
    try {
      const response = await frontDeskFetch('/api/accounts/introduction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const data: unknown = await response.json();
      if (ticket !== sequence.current) return;
      if (!response.ok || !object(data) || data.ok !== true) {
        if (object(data) && data.error === 'account_recovery_required') setMessage('recovery');
        throw new Error(
          object(data) && data.error === 'account_recovery_required' ? 'recovery' : 'unavailable'
        );
      }
      if (action === 'preview') {
        if (
          data.binding_id !== bindingId ||
          typeof data.service_id !== 'string' ||
          typeof data.digest !== 'string' ||
          typeof data.statement !== 'string' ||
          !(data.expected_generation === null || typeof data.expected_generation === 'string') ||
          !Array.isArray(data.secret_refs) ||
          !data.secret_refs.length ||
          !data.secret_refs.every(
            (key) => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(key)
          )
        )
          throw new Error('invalid');
        setPreview(data as Preview);
        setPending(null);
        setValues({});
      } else if (action === 'request') {
        if (
          typeof data.approval_id !== 'string' ||
          typeof data.approval_url !== 'string' ||
          !data.approval_url.startsWith('/?approvalId=')
        )
          throw new Error('invalid');
        setPending({
          approval_id: data.approval_id,
          approval_url: data.approval_url,
          can_apply: false,
        });
      } else if (action === 'status') {
        if (typeof data.can_apply !== 'boolean') throw new Error('invalid');
        setValues({});
        setPending((old) => (old ? { ...old, can_apply: data.can_apply === true } : null));
        if (data.status === 'recovery_required') setMessage('recovery');
        if (data.status === 'applied') {
          setPending(null);
          setPreview(null);
          setMessage('saved');
        }
      } else {
        if (data.status !== 'applied' || typeof data.generation !== 'string')
          throw new Error('invalid');
        setPending(null);
        setPreview(null);
        setMessage('saved');
      }
    } catch (error) {
      if (ticket !== sequence.current) return;
      setValues({});
      setPending((old) => (old ? { ...old, can_apply: false } : null));
      setMessage(
        action === 'apply' || (error instanceof Error && error.message === 'recovery')
          ? 'recovery'
          : 'error'
      );
    } finally {
      if (ticket === sequence.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="settings-row-block">
      <Button
        label={t('settings.account_preview')}
        disabled={busy || pending !== null}
        onClick={() => void run('preview')}
      />
      {preview ? (
        <>
          <p className="kb-text kb-text--caption">{preview.statement}</p>
          {!pending ? (
            <Button
              label={t('settings.secret_propose')}
              disabled={busy}
              onClick={() => void run('request')}
            />
          ) : (
            <>
              <a href={pending.approval_url} target="_blank" rel="noopener noreferrer">
                {t('settings.account_open_approval')}
              </a>
              <Button
                label={t('settings.account_refresh')}
                disabled={busy}
                onClick={() => void run('status')}
              />
              {pending.can_apply ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run('apply');
                  }}
                >
                  {preview.secret_refs.map((key) => (
                    <label key={key}>
                      {t('settings.secret_value')} — {key}
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        value={values[key] ?? ''}
                        disabled={busy}
                        maxLength={16384}
                        onChange={(event) =>
                          setValues((old) => ({ ...old, [key]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <p>{t('settings.secret_value_help')}</p>
                  <Button
                    label={t('settings.account_apply')}
                    disabled={busy || preview.secret_refs.some((key) => !values[key])}
                    onClick={() => void run('apply')}
                  />
                </form>
              ) : (
                <p>{t('settings.secret_value_locked')}</p>
              )}
            </>
          )}
        </>
      ) : null}
      {preview ? (
        <>
          <Button
            label={t('settings.account_close')}
            disabled={busy}
            onClick={() => {
              sequence.current += 1;
              controller.current?.abort();
              setValues({});
              setPreview(null);
              setPending(null);
              setMessage(null);
            }}
          />
          <p className="kb-text kb-text--caption">{t('settings.account_close_help')}</p>
        </>
      ) : null}
      {busy ? <p role="status">{t('authority.pending')}</p> : null}
      {message ? (
        <Callout
          tone={message === 'saved' ? 'success' : 'danger'}
          title={
            message === 'recovery'
              ? t('settings.account_recovery')
              : message === 'error'
                ? t('settings.operator_unavailable')
                : t('settings.secret_applied', { env: bindingId })
          }
        />
      ) : null}
    </div>
  );
}
