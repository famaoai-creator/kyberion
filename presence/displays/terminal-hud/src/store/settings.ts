import { getInstalledReasoningMode, resolveActiveProfileRoot, pathResolver } from '@agent/core';
import { activeCustomer } from '@agent/core/customer-resolver';
import { getRegisteredEnvText } from '@agent/core/foundation';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

export interface SettingsData {
  reasoningMode: string;
  customer: string;
  profileRoot: string;
  rootDir: string;
}

export function loadSettings(): SettingsData {
  let reasoningMode = getRegisteredEnvText('KYBERION_REASONING_BACKEND') ?? '';
  try {
    reasoningMode = getInstalledReasoningMode() ?? reasoningMode;
  } catch {
    // reasoning backend not bootstrapped in this process
  }
  return {
    reasoningMode: reasoningMode || 'auto',
    customer: activeCustomer() ?? '-',
    profileRoot: resolveActiveProfileRoot(),
    rootDir: pathResolver.rootDir(),
  };
}

export function settingsWatchPaths(): string[] {
  return [pathResolver.active('shared/runtime/customer.env')];
}

export function settingsViewModel(data: SettingsData, i18n: I18n): PanelViewModel {
  const hint = (command: string) => i18n.tr('tui:tui_settings_readonly_hint', { command });
  return {
    columns: [i18n.tr('tui:tui_tab_settings'), '', ''],
    rows: [
      {
        id: 'reasoning',
        cells: [
          i18n.tr('tui:tui_settings_reasoning'),
          data.reasoningMode,
          hint('pnpm reasoning:config'),
        ],
      },
      {
        id: 'customer',
        cells: [i18n.tr('tui:tui_status_customer'), data.customer, hint('pnpm customer:switch')],
      },
      {
        id: 'locale',
        cells: [
          i18n.tr('tui:tui_status_locale'),
          i18n.locale,
          i18n.tr('tui:tui_settings_locale_toggle'),
        ],
      },
      {
        id: 'profile-root',
        cells: [i18n.tr('tui:tui_settings_profile_root'), data.profileRoot, ''],
      },
      { id: 'root', cells: ['root', data.rootDir, ''] },
    ],
  };
}
