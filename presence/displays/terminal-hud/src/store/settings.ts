import { computeApprovalPresentedDigest } from '@agent/core/governance/approval-presentation';
import type { OperatorHomeApprovalItem } from '@agent/core/surface/operator-home-summary';
import { getInstalledReasoningMode } from '@agent/core/reasoning/reasoning-bootstrap';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { pathResolver } from '@agent/core/path-resolver';
import { activeCustomer } from '@agent/core/customer-resolver';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

export interface SettingsData {
  reasoningMode: string;
  customer: string;
  profileRoot: string;
  rootDir: string;
  connectionsUrl?: string;
  approvals?: OperatorHomeApprovalItem[];
}

export function loadSettings(): SettingsData {
  let reasoningMode = getRegisteredEnvText('KYBERION_REASONING_BACKEND') ?? '';
  try {
    reasoningMode = getInstalledReasoningMode() ?? reasoningMode;
  } catch {
    // reasoning backend not bootstrapped in this process
  }
  let connectionsUrl: string | undefined;
  try {
    // A navigation target from the registered surface, not a health probe or
    // a connection grant. Concierge resolves the viewer's scope on arrival.
    const target = new URL(resolveSurfaceBrowserUrl('concierge'));
    target.pathname = `${target.pathname.replace(/\/$/u, '')}/settings`;
    // Never echo query-string credentials or fragments from a runtime URL.
    target.search = '';
    target.hash = 'setup-services';
    connectionsUrl = target.href;
  } catch {
    // Missing/invalid surface configuration must not break the settings HUD.
  }
  return {
    reasoningMode: reasoningMode || 'auto',
    customer: activeCustomer() ?? '-',
    profileRoot: resolveActiveProfileRoot(),
    rootDir: pathResolver.rootDir(),
    connectionsUrl,
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
      ...(data.approvals || []).map((approval) => ({
        id: `approval:${approval.id}`,
        cells: [i18n.tr('tui:tui_approval_review'), approval.title, approval.expiresAt || '—'],
        detail: [
          { label: 'ID', value: approval.id },
          { label: i18n.tr('tui:tui_approval_reason'), value: approval.summary },
          { label: i18n.tr('tui:tui_approval_expires'), value: approval.expiresAt || '—' },
          { label: 'digest', value: computeApprovalPresentedDigest(approval) },
          ...(approvalReviewUrl(approval.id)
            ? [
                {
                  label: i18n.tr('tui:tui_approval_review'),
                  value: approvalReviewUrl(approval.id)!,
                },
              ]
            : []),
          { label: '', value: i18n.tr('tui:tui_approval_review_hint') },
        ],
      })),
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
        cells: [i18n.tr('tui:tui_status_customer'), data.customer, hint('pnpm stance:switch')],
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
    sections: [
      {
        title: i18n.tr('tui:tui_connections'),
        lines: [
          i18n.tr('tui:tui_connections_hint'),
          ...(data.connectionsUrl ? [data.connectionsUrl] : []),
        ],
      },
    ],
  };
}

/** Navigation only; the receiving surface resolves the current viewer again. */
export function approvalReviewUrl(id: string): string | undefined {
  try {
    const target = new URL(resolveSurfaceBrowserUrl('concierge'));
    target.search = '';
    target.hash = `decide-approval-${id}`;
    return target.href;
  } catch {
    return undefined;
  }
}
