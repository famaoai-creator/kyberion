'use client';

import * as React from 'react';
import { Button, Select, SettingRow, SettingsGroup, TextField } from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import type { NotificationChannelOption, NotificationTarget } from '../../../lib/settings-types';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

/** FD-06 通知設定 pane (`#setup-notifications`) — extracted from
 * settings/page.tsx; the save handler and channel list stay owned by the
 * page. UI-06: shared `Select` / `TextField` rows. */
export type NotificationsSectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
  notifCurrent: NotificationTarget | null;
  notif: NotificationTarget;
  setNotif: (notif: NotificationTarget) => void;
  notifChannels: NotificationChannelOption[];
  channelDisplayName: (surface: string) => string;
  busy: boolean;
  onSaveNotification: () => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function NotificationsSection({
  locale,
  t,
  notifCurrent,
  notif,
  setNotif,
  notifChannels,
  channelDisplayName,
  busy,
  onSaveNotification,
  sectionRef,
}: NotificationsSectionProps) {
  return (
    <div
      className="settings-section"
      id="setup-notifications"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_notifications', locale)}
    >
      <FormScope
        fields={{
          'notification.surface': (value) => setNotif({ ...notif, surface: asText(value) }),
          'notification.target': (value) => setNotif({ ...notif, target: asText(value) }),
        }}
      >
        <SettingsGroup
          id="settings-notifications"
          title={frontDeskText('settings_nav_notifications', locale)}
          description={t('setup.notifications_description')}
        >
          <SettingRow
            label={t('setup.notification_surface')}
            description={
              notifCurrent
                ? t('setup.notification_current', {
                    value: `${channelDisplayName(notifCurrent.surface)} ${notifCurrent.target}`,
                  })
                : t('setup.notification_none')
            }
          >
            <Select
              id="notification-surface"
              name="notification.surface"
              label={t('setup.notification_surface')}
              hide_label
              value={notif.surface}
              options={[
                { value: 'none', label: t('setup.notification_off_option') },
                ...notifChannels.map((channel) => ({
                  value: channel.surface,
                  label: channel.display_name,
                })),
              ]}
            />
          </SettingRow>
          {notif.surface !== 'none' ? (
            <SettingRow label={t('setup.notification_target')}>
              <TextField
                id="notification-target"
                name="notification.target"
                label={t('setup.notification_target')}
                hide_label
                value={notif.target}
                placeholder={t('setup.notification_target_placeholder')}
              />
            </SettingRow>
          ) : null}
          <div className="settings-row-actions">
            <Button
              label={t('setup.notification_save')}
              variant="primary"
              disabled={busy || (notif.surface !== 'none' && !notif.target.trim())}
              onClick={onSaveNotification}
            />
          </div>
        </SettingsGroup>
      </FormScope>
    </div>
  );
}
