'use client';

import * as React from 'react';
import { Badge } from '@agent/shared-ui';
import { frontDeskText, type ConciergeLocale } from '../../../lib/i18n';

/**
 * Settings IA building blocks (MSN-SHELL-IA-20261105 §4): every setting says
 * its current value, its default and what changing it does, in one line each;
 * a terminal-only setting keeps the exact command behind a disclosure so the
 * visible text never shows a raw command.
 */

export function SettingMeta({
  locale,
  current,
  defaultValue,
  effect,
}: {
  locale: ConciergeLocale;
  current?: string;
  defaultValue?: string;
  effect?: string;
}) {
  const rows = [
    current ? frontDeskText('ia_settings_meta_current', locale, { value: current }) : null,
    defaultValue
      ? frontDeskText('ia_settings_meta_default', locale, { value: defaultValue })
      : null,
    effect ? frontDeskText('ia_settings_meta_effect', locale, { value: effect }) : null,
  ].filter((row): row is string => Boolean(row));
  if (rows.length === 0) return null;
  return (
    <ul className="settings-meta" aria-label={frontDeskText('ia_settings_meta_label', locale)}>
      {rows.map((row) => (
        <li key={row} className="kb-text kb-text--caption">
          {row}
        </li>
      ))}
    </ul>
  );
}

/** The exact terminal command, collapsed, with a copy button. */
export function SettingsCommand({
  locale,
  command,
  label,
}: {
  locale: ConciergeLocale;
  command: string;
  label?: string;
}) {
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  React.useEffect(() => {
    if (copy !== 'copied') return;
    const timer = setTimeout(() => setCopy('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copy]);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <details className="settings-command">
      <summary>{label ?? frontDeskText('ia_settings_command_show', locale)}</summary>
      <div className="settings-command__body">
        <pre className="settings-command__code">
          <code>{command}</code>
        </pre>
        <div className="settings-inline-actions">
          <button type="button" className="kb-btn kb-btn--ghost" onClick={() => void onCopy()}>
            {frontDeskText(
              copy === 'copied' ? 'ia_settings_command_copied' : 'ia_settings_command_copy',
              locale
            )}
          </button>
          <span role="status" className="kb-text kb-text--caption">
            {copy === 'failed' ? frontDeskText('ia_settings_command_copy_failed', locale) : ''}
          </span>
        </div>
      </div>
    </details>
  );
}

/** A setting that has no screen yet: what it is, a badge, and the command. */
export function CliSettingRow({
  locale,
  label,
  description,
  command,
}: {
  locale: ConciergeLocale;
  label: string;
  description?: string;
  command: string;
}) {
  return (
    <div className="settings-row-block settings-cli-row">
      <div className="settings-cli-row__head">
        <p className="kb-text kb-text--body">{label}</p>
        <Badge label={frontDeskText('ia_settings_cli_badge', locale)} tone="neutral" />
      </div>
      {description ? <p className="kb-text kb-text--muted">{description}</p> : null}
      <SettingsCommand locale={locale} command={command} />
    </div>
  );
}
