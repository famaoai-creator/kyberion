import path from 'node:path';
import {
  resolveOperatorDisplayName,
  resolveOperatorLocale,
  resolveActiveProfileRoot,
  listAgentIdentities,
  loadOrganizationProfile,
} from '@agent/core';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { statusColor } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

export interface ProfileData {
  operatorName: string;
  operatorLocale: string;
  profileRoot: string;
  organizationName: string;
  onboardingLines: string[];
  identities: Array<{ id: string; status: string; display: string }>;
}

export function loadProfile(): ProfileData {
  const profileRoot = resolveActiveProfileRoot();
  let onboardingLines: string[] = [];
  try {
    const statePath = path.join(profileRoot, 'onboarding', 'onboarding-state.json');
    if (safeExistsSync(statePath)) {
      const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
      onboardingLines = Object.entries(state)
        .filter(([, value]) => typeof value !== 'object' || value === null)
        .slice(0, 10)
        .map(([key, value]) => `${key}: ${String(value)}`);
    }
  } catch {
    // unreadable onboarding state renders as empty
  }
  let identities: ProfileData['identities'] = [];
  try {
    identities = listAgentIdentities().map((record: any) => ({
      id: String(record.nhi_id ?? record.id ?? '?'),
      status: String(record.lifecycle_status ?? record.status ?? '-'),
      display: String(record.display_name ?? record.role ?? ''),
    }));
  } catch {
    // identity journal may not exist yet
  }
  let organizationName = '-';
  try {
    organizationName = loadOrganizationProfile()?.name ?? '-';
  } catch {
    // organization profile is optional
  }
  return {
    operatorName: resolveOperatorDisplayName(),
    operatorLocale: resolveOperatorLocale(),
    profileRoot,
    organizationName,
    onboardingLines,
    identities,
  };
}

export function profileWatchPaths(): string[] {
  return [path.join(resolveActiveProfileRoot(), 'onboarding')];
}

export function profileViewModel(data: ProfileData, i18n: I18n): PanelViewModel {
  const sections = [
    {
      title: i18n.tr('tui:tui_profile_operator'),
      lines: [
        `${data.operatorName} (${data.operatorLocale})`,
        `${i18n.tr('tui:tui_settings_profile_root')}: ${data.profileRoot}`,
        `${i18n.tr('tui:tui_profile_org')}: ${data.organizationName}`,
      ],
    },
  ];
  if (data.onboardingLines.length > 0) {
    sections.push({ title: i18n.tr('tui:tui_profile_onboarding'), lines: data.onboardingLines });
  }
  return {
    columns: [i18n.tr('tui:tui_profile_identities'), i18n.tr('tui:tui_mission_col_status'), ''],
    rows: data.identities.map((identity) => ({
      id: identity.id,
      color: statusColor(identity.status),
      cells: [identity.id, identity.status, identity.display],
    })),
    sections,
  };
}
