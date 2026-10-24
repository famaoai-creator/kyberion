'use client';

import { Button, Disclosure, SettingRow, StatusPill } from '@agent/shared-ui';
import type { ConciergeMessageKey } from '../../lib/i18n';
import type { SetupDiagnostic } from '../../lib/setup-response';
import type { SettingsTranslate } from './sections/form-scope';

const LABELS: Record<string, ConciergeMessageKey> = {
  profile: 'setup.diag.profile',
  avatar: 'setup.diag.avatar',
  voice: 'setup.diag.voice',
  services: 'setup.diag.services',
  notifications: 'setup.diag.notifications',
  reasoning: 'setup.diag.reasoning',
};

/** A compact overview; the actual settings remain the primary page content. */
export function SettingsReadiness({
  diagnostics,
  t,
  onNavigate,
}: {
  diagnostics: readonly SetupDiagnostic[];
  t: SettingsTranslate;
  onNavigate: (target: string) => void;
}) {
  const completed = diagnostics.filter((item) => item.status === 'ok').length;
  const errors = diagnostics.filter((item) => item.status === 'error').length;
  const summary = [
    t('setup.readiness_title'),
    `${t('setup.completed')}: ${completed}/${diagnostics.length}`,
    ...(errors ? [`${t('setup.diag_error')}: ${errors}`] : []),
  ].join(' · ');
  return (
    <div className="settings-readiness">
      <Disclosure summary={summary}>
        <p className="kb-text kb-text--muted">{t('setup.readiness_description')}</p>
        <div className="settings-readiness-rows">
          {diagnostics.map((item) => (
            <div className="settings-row-group" key={item.id}>
              <SettingRow label={LABELS[item.id] ? t(LABELS[item.id]) : item.id}>
                <div className="settings-inline-actions">
                  <StatusPill
                    status={
                      item.status === 'ok'
                        ? 'completed'
                        : item.status === 'error'
                          ? 'error'
                          : 'needs_setup'
                    }
                    label={t(
                      item.status === 'ok'
                        ? 'setup.completed'
                        : item.status === 'error'
                          ? 'setup.diag_error'
                          : 'setup.incomplete'
                    )}
                  />
                  {item.status !== 'ok' && item.action ? (
                    <Button
                      label={t('setup.fix_here')}
                      variant="secondary"
                      onClick={() => onNavigate(item.action!.target)}
                    />
                  ) : null}
                </div>
              </SettingRow>
              {item.status !== 'ok' && !item.action && item.id === 'reasoning' ? (
                <div className="settings-row-block">
                  <p className="kb-text kb-text--muted">{t('setup.reasoning_guidance')}</p>
                  {item.command ? (
                    <p className="kb-text kb-text--caption readiness-command">
                      {t('setup.reasoning_command_hint', { value: item.command })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}
