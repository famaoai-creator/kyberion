'use client';

import * as React from 'react';
import { Button, Select, SettingRow, SettingsGroup, TextField } from '@agent/shared-ui';
import {
  URGENT_PRESET_EVENTS,
  defaultTimezone,
  isValidQuietHoursInput,
  parseQuietHoursResponse,
  presetFromUrgentEvents,
  type UrgentPreset,
} from '../../../lib/quiet-hours-view';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

/** 通知設定 › おやすみ時間. Owns its own load/save (independent of the channel form). */
export function QuietHoursPane({ t }: { t: SettingsTranslate }) {
  const [enabled, setEnabled] = React.useState(false);
  const [start, setStart] = React.useState('22:00');
  const [end, setEnd] = React.useState('07:00');
  const [timezone, setTimezone] = React.useState(defaultTimezone);
  const [preset, setPreset] = React.useState<UrgentPreset>('alerts_only');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; error?: boolean } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/notification-preferences', { cache: 'no-store' })
      .then((response) => response.json().catch(() => null))
      .then((data: unknown) => {
        const parsed = parseQuietHoursResponse(data);
        if (!parsed || cancelled) return;
        setEnabled(parsed.quiet_hours !== null);
        if (parsed.quiet_hours) {
          setStart(parsed.quiet_hours.start);
          setEnd(parsed.quiet_hours.end);
          setTimezone(parsed.quiet_hours.timezone);
        }
        setPreset(presetFromUrgentEvents(parsed.urgent_events));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const valid = !enabled || isValidQuietHoursInput({ start, end, timezone });

  const save = async () => {
    if (!valid) {
      setMessage({ text: t('setup.quiet_hours_invalid'), error: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/notification-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quiet_hours: enabled ? { start, end, timezone: timezone.trim() } : null,
          urgent_events: URGENT_PRESET_EVENTS[preset],
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || t('setup.quiet_hours_invalid'));
      setMessage({ text: t('setup.quiet_hours_saved') });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormScope
      fields={{
        'quiet.enabled': (value) => setEnabled(asText(value) === 'on'),
        'quiet.start': (value) => setStart(asText(value)),
        'quiet.end': (value) => setEnd(asText(value)),
        'quiet.timezone': (value) => setTimezone(asText(value)),
        'quiet.urgent': (value) => setPreset(asText(value) as UrgentPreset),
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
                value={start}
              />
            </SettingRow>
            <SettingRow label={t('setup.quiet_hours_end')}>
              <TextField
                id="quiet-hours-end"
                name="quiet.end"
                label={t('setup.quiet_hours_end')}
                hide_label
                value={end}
              />
            </SettingRow>
            <SettingRow label={t('setup.quiet_hours_timezone')}>
              <TextField
                id="quiet-hours-timezone"
                name="quiet.timezone"
                label={t('setup.quiet_hours_timezone')}
                hide_label
                value={timezone}
              />
            </SettingRow>
            <SettingRow label={t('setup.urgent_events_label')}>
              <Select
                id="quiet-hours-urgent"
                name="quiet.urgent"
                label={t('setup.urgent_events_label')}
                hide_label
                value={preset}
                options={[
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
            disabled={busy || !valid}
            onClick={() => void save()}
          />
        </div>
        {message ? (
          <p role={message.error ? 'alert' : 'status'} className="settings-row-note">
            {message.text}
          </p>
        ) : null}
      </SettingsGroup>
    </FormScope>
  );
}
