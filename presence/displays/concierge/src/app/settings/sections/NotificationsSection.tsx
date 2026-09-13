'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { NotificationChannelOption, NotificationTarget } from '../../../lib/settings-types';

/** FD-06 通知設定 pane (`#setup-notifications`) — extracted from
 * settings/page.tsx; the save handler and channel list stay owned by the
 * page. */
export type NotificationsSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
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
    <section
      className="pane"
      id="setup-notifications"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_notifications', locale)}
    >
      <h2>{frontDeskText('settings_nav_notifications', locale)}</h2>
      <h3 className="pane-subheading">{t('setup.notifications_title')}</h3>
      <p className="pane-subtitle">{t('setup.notifications_description')}</p>
      <p className="item-meta">
        {notifCurrent
          ? t('setup.notification_current', {
              value: `${channelDisplayName(notifCurrent.surface)} ${notifCurrent.target}`,
            })
          : t('setup.notification_none')}
      </p>
      <label className="field-label">
        {t('setup.notification_surface')}
        <select
          value={notif.surface}
          onChange={(event) => setNotif({ ...notif, surface: event.target.value })}
        >
          <option value="none">{t('setup.notification_off_option')}</option>
          {notifChannels.map((channel) => (
            <option key={channel.surface} value={channel.surface}>
              {channel.display_name}
            </option>
          ))}
        </select>
      </label>
      {notif.surface !== 'none' ? (
        <label className="field-label">
          {t('setup.notification_target')}
          <input
            value={notif.target}
            onChange={(event) => setNotif({ ...notif, target: event.target.value })}
            placeholder={t('setup.notification_target_placeholder')}
          />
        </label>
      ) : null}
      <div className="button-row">
        <button
          className="action-button"
          disabled={busy || (notif.surface !== 'none' && !notif.target.trim())}
          onClick={onSaveNotification}
        >
          {t('setup.notification_save')}
        </button>
      </div>
    </section>
  );
}
