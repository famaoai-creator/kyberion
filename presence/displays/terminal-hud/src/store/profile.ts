import path from 'node:path';
import { resolveOperatorDisplayName, resolveOperatorLocale } from '@agent/core/operator-identity';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { listAgentIdentities } from '@agent/core/agent-identity';
import { loadOrganizationProfile } from '@agent/core/organization-profile';
import { parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
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

export function formatOnboardingState(value: unknown): string[] {
  const state = parseSafeJsonObjectValue(value, 'onboarding state');
  return Object.entries(state)
    .filter(([, entry]) => typeof entry !== 'object' || entry === null)
    .slice(0, 10)
    .map(([key, entry]) => `${key}: ${String(entry)}`);
}

export function loadProfile(): ProfileData {
  const profileRoot = resolveActiveProfileRoot();
  let onboardingLines: string[] = [];
  try {
    const statePath = path.join(profileRoot, 'onboarding', 'onboarding-state.json');
    const safeStatePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
    if (safeExistsSync(safeStatePath) && safeLstat(safeStatePath).isFile()) {
      onboardingLines = formatOnboardingState(readJson<unknown>(safeStatePath));
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
