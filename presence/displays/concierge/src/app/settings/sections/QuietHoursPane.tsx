'use client';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import {
  getFrontDeskAuthRevision,
  readFrontDeskRequestToken,
} from '../../../lib/front-desk-auth-token';
import * as React from 'react';
import { Button, Select, SettingRow, SettingsGroup, TextField } from '@agent/shared-ui';
import {
  URGENT_PRESET_EVENTS,
  defaultTimezone,
  isValidQuietHoursInput,
  parseQuietHoursResponse,
  presetFromUrgentEvents,
  matchesQuietHoursPreferences,
  type QuietHoursPreferences,
  type UrgentPreset,
} from '../../../lib/quiet-hours-view';
import type { ConciergeMessageKey } from '../../../lib/i18n';
import { FormScope, asText, type SettingsTranslate } from './form-scope';
type AuthSnapshot = { revision: number; token: string | null };
const currentAuth = (): AuthSnapshot => ({
  revision: getFrontDeskAuthRevision(),
  token: readFrontDeskRequestToken(),
});
function sameAuth(expected: AuthSnapshot | null): boolean {
  try {
    const current = currentAuth();
    return (
      expected !== null &&
      current.revision === expected.revision &&
      current.token === expected.token
    );
  } catch {
    return false;
  }
}
/** Saved preferences are a prerequisite to editing; uncertain writes recover by reading only. */
export function QuietHoursPane({ t }: { t: SettingsTranslate }) {
  const [enabled, setEnabled] = React.useState(false);
  const [start, setStart] = React.useState('22:00');
  const [end, setEnd] = React.useState('07:00');
  const [timezone, setTimezone] = React.useState(defaultTimezone);
  const [urgentEvents, setUrgentEvents] = React.useState<string[]>(
    URGENT_PRESET_EVENTS.alerts_only
  );
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = React.useState(false);
  const [formRevision, setFormRevision] = React.useState(0);
  const [message, setMessage] = React.useState<{
    key: ConciergeMessageKey;
    error?: boolean;
    detail?: string;
  } | null>(null);
  const requestRef = React.useRef<AbortController | null>(null);
  const authRef = React.useRef<AuthSnapshot | null>(null);
  const mountedRef = React.useRef(true);
  const preset = presetFromUrgentEvents(urgentEvents);
  const load = React.useCallback(async () => {
    if (requestRef.current || !mountedRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const ownsRequest = () => mountedRef.current && requestRef.current === controller;
    setLoadState('loading');
    setMessage(null);
    authRef.current = null;
    try {
      const auth = currentAuth();
      const response = await fetch('/api/notification-preferences', {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      const parsed = parseQuietHoursResponse(await response.json());
      if (!ownsRequest()) return;
      if (!response.ok || !parsed || !sameAuth(auth))
        throw Error('Unverified quiet-hours preferences');
      setEnabled(parsed.quiet_hours !== null);
      if (parsed.quiet_hours) {
        setStart(parsed.quiet_hours.start);
        setEnd(parsed.quiet_hours.end);
        setTimezone(parsed.quiet_hours.timezone);
      }
      setUrgentEvents(parsed.urgent_events);
      // Shared controls echo edits locally; a verified reload must reset even rejected echoes.
      setFormRevision((revision) => revision + 1);
      authRef.current = auth;
      setLoadState('ready');
    } catch {
      if (ownsRequest()) {
        setLoadState('error');
        setMessage({ key: 'setup.quiet_hours_load_failed', error: true });
      }
    } finally {
      if (ownsRequest()) requestRef.current = null;
    }
  }, []);
  React.useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
      authRef.current = null;
    };
  }, [load]);
  const valid = !enabled || isValidQuietHoursInput({ start, end, timezone });
  const editable = loadState === 'ready' && !busy;
  const requireLoadedAuth = () => {
    if (sameAuth(authRef.current)) return true;
    authRef.current = null;
    setLoadState('error');
    setMessage({ key: 'setup.quiet_hours_load_failed', error: true });
    return false;
  };
  const edit = (apply: () => void) => {
    if (!editable || requestRef.current || !requireLoadedAuth()) return;
    apply();
    setMessage(null);
  };
  const save = async () => {
    if (!editable || requestRef.current || !requireLoadedAuth()) return;
    if (!valid) {
      setMessage({ key: 'setup.quiet_hours_invalid', error: true });
      return;
    }
    const submitted: QuietHoursPreferences = {
      quiet_hours: enabled ? { start, end, timezone: timezone.trim() } : null,
      urgent_events: [...urgentEvents],
    };
    const auth = authRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    const ownsRequest = () => mountedRef.current && requestRef.current === controller;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/notification-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitted),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      const body: unknown = await response.json();
      const parsed = parseQuietHoursResponse(body);
      if (!ownsRequest()) return;
      // The endpoint's explicit validation rejection is pre-write: keep the draft correctable.
      if (
        response.status === 400 &&
        sameAuth(auth) &&
        body &&
        typeof body === 'object' &&
        'ok' in body &&
        body.ok === false &&
        'error' in body &&
        typeof body.error === 'string' &&
        body.error
      ) {
        setMessage({ key: 'setup.quiet_hours_invalid', detail: body.error, error: true });
        return;
      }
      if (
        !response.ok ||
        !parsed ||
        !sameAuth(auth) ||
        !matchesQuietHoursPreferences(parsed, submitted)
      )
        throw Error('Unverified quiet-hours save');
      setMessage({ key: 'setup.quiet_hours_saved' });
    } catch {
      if (ownsRequest()) {
        authRef.current = null;
        setLoadState('error');
        setMessage({ key: 'setup.quiet_hours_save_unverified', error: true });
      }
    } finally {
      if (ownsRequest()) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <FormScope
      key={formRevision}
      fields={{
        'quiet.enabled': (value) => edit(() => setEnabled(asText(value) === 'on')),
        'quiet.start': (value) => edit(() => setStart(asText(value))),
        'quiet.end': (value) => edit(() => setEnd(asText(value))),
        'quiet.timezone': (value) => edit(() => setTimezone(asText(value))),
        'quiet.urgent': (value) =>
          edit(() => {
            const selected = asText(value);
            if (Object.hasOwn(URGENT_PRESET_EVENTS, selected))
              setUrgentEvents([...URGENT_PRESET_EVENTS[selected as UrgentPreset]]);
          }),
      }}
    >
      <SettingsGroup
        id="settings-quiet-hours"
        title={t('setup.quiet_hours_title')}
        description={t('setup.quiet_hours_description')}
      >
        <SettingRow label={t('setup.quiet_hours_enabled')}>
          <Select
            id="quiet-hours-enabled"
            name="quiet.enabled"
            label={t('setup.quiet_hours_enabled')}
            hide_label
            disabled={!editable}
            value={enabled ? 'on' : 'off'}
            options={[
              { value: 'off', label: t('setup.quiet_hours_off_option') },
              { value: 'on', label: t('setup.quiet_hours_on_option') },
            ]}
          />
        </SettingRow>
        {enabled ? (
          <>
            <SettingRow label={t('setup.quiet_hours_start')}>
              <TextField
                id="quiet-hours-start"
                name="quiet.start"
                label={t('setup.quiet_hours_start')}
                hide_label
                disabled={!editable}
                value={start}
              />
            </SettingRow>
            <SettingRow label={t('setup.quiet_hours_end')}>
              <TextField
                id="quiet-hours-end"
                name="quiet.end"
                label={t('setup.quiet_hours_end')}
                hide_label
                disabled={!editable}
                value={end}
              />
            </SettingRow>
            <SettingRow label={t('setup.quiet_hours_timezone')}>
              <TextField
                id="quiet-hours-timezone"
                name="quiet.timezone"
                label={t('setup.quiet_hours_timezone')}
                hide_label
                disabled={!editable}
                value={timezone}
              />
            </SettingRow>
            <SettingRow label={t('setup.urgent_events_label')}>
              <Select
                id="quiet-hours-urgent"
                name="quiet.urgent"
                label={t('setup.urgent_events_label')}
                hide_label
                disabled={!editable}
                value={preset}
                options={[
                  ...(preset === 'custom'
                    ? [{ value: 'custom', label: t('setup.quiet_hours_custom_urgent') }]
                    : []),
                  { value: 'alerts_only', label: t('setup.urgent_alerts_only') },
                  { value: 'alerts_approvals', label: t('setup.urgent_alerts_approvals') },
                  {
                    value: 'alerts_approvals_questions',
                    label: t('setup.urgent_alerts_approvals_questions'),
                  },
                ]}
              />
            </SettingRow>
          </>
        ) : null}
        <div className="settings-row-actions">
          <Button
            label={t('setup.quiet_hours_save')}
            variant="primary"
            disabled={!editable || !valid}
            onClick={() => void save()}
          />
        </div>
        {busy ? (
          <p role="status" className="settings-row-note">
            {t('setup.quiet_hours_saving')}
          </p>
        ) : null}
        {loadState === 'loading' ? (
          <p role="status" className="settings-row-note">
            {t('setup.quiet_hours_loading')}
          </p>
        ) : null}
        {loadState === 'error' ? (
          <Button label={t('setup.quiet_hours_reload')} onClick={() => void load()} />
        ) : null}
        {message ? (
          <p role={message.error ? 'alert' : 'status'} className="settings-row-note">
            {message.detail || t(message.key)}
          </p>
        ) : null}
      </SettingsGroup>
    </FormScope>
  );
}
