/**
 * `/settings` information architecture (MSN-SHELL-IA-20261105 §4): pure
 * helpers, no I/O. The page is two panes: categories (`SettingsSectionId`)
 * on the left, the cards of the active category on the right. Every card has
 * a stable element id that `/settings#<id>` deep links, the ⌘K palette and
 * the Home dashboard target; legacy `#setup-…` anchors stay valid.
 *
 * Translation stays with the caller: the catalog only names vocabulary keys.
 */
import type { FrontDeskMessageKey } from './i18n';
import {
  SETUP_CHECKLIST_ANCHORS,
  SETUP_CHECKLIST_ORDER,
  type SetupChecklistStepId,
} from '@agent/core/surface/setup-checklist-model';

/** Left-pane categories, in display order. */
export type SettingsSectionId =
  | 'start'
  | 'workspace'
  | 'agents'
  | 'notifications'
  | 'connections'
  | 'data'
  | 'budget'
  | 'display'
  | 'advanced';

export const SETTINGS_SECTION_ORDER: readonly SettingsSectionId[] = [
  'start',
  'workspace',
  'agents',
  'notifications',
  'connections',
  'data',
  'budget',
  'display',
  'advanced',
];

export interface SettingsCategory {
  label: FrontDeskMessageKey;
  description: FrontDeskMessageKey;
  icon: string;
}

export const SETTINGS_CATEGORIES: Record<SettingsSectionId, SettingsCategory> = {
  start: {
    label: 'ia_settings_cat_start',
    description: 'ia_settings_cat_start_desc',
    icon: 'check',
  },
  workspace: {
    label: 'ia_settings_cat_workspace',
    description: 'ia_settings_cat_workspace_desc',
    icon: 'users',
  },
  agents: {
    label: 'ia_settings_cat_agents',
    description: 'ia_settings_cat_agents_desc',
    icon: 'approval',
  },
  notifications: {
    label: 'ia_settings_cat_notifications',
    description: 'ia_settings_cat_notifications_desc',
    icon: 'bell',
  },
  connections: {
    label: 'ia_settings_cat_connections',
    description: 'ia_settings_cat_connections_desc',
    icon: 'puzzle',
  },
  data: { label: 'ia_settings_cat_data', description: 'ia_settings_cat_data_desc', icon: 'shield' },
  budget: {
    label: 'ia_settings_cat_budget',
    description: 'ia_settings_cat_budget_desc',
    icon: 'chart',
  },
  display: {
    label: 'ia_settings_cat_display',
    description: 'ia_settings_cat_display_desc',
    icon: 'monitor',
  },
  advanced: {
    label: 'ia_settings_cat_advanced',
    description: 'ia_settings_cat_advanced_desc',
    icon: 'settings',
  },
};

/** Element id of each category's container (`/settings#settings-cat-<id>`). */
export const SETTINGS_SECTION_ELEMENT_ID = Object.fromEntries(
  SETTINGS_SECTION_ORDER.map((id) => [id, `settings-cat-${id}`])
) as Record<SettingsSectionId, string>;

export interface SettingsCard {
  /** Stable element id (`/settings#<id>`). */
  id: string;
  category: SettingsSectionId;
  label: FrontDeskMessageKey;
  description: FrontDeskMessageKey;
}

const card = (
  id: string,
  category: SettingsSectionId,
  label: FrontDeskMessageKey,
  description: FrontDeskMessageKey
): SettingsCard => ({ id, category, label, description });

/**
 * Every card, in render order. The search box and the ⌘K palette filter this
 * list by translated label and description.
 */
export const SETTINGS_CARDS: readonly SettingsCard[] = [
  card('settings-checklist', 'start', 'ia_settings_checklist_title', 'ia_settings_checklist_lead'),
  card('settings-trial-mission', 'start', 'ia_settings_card_trial', 'ia_settings_card_trial_desc'),
  card('setup-profile', 'workspace', 'settings_nav_profile', 'settings_desc_profile'),
  card('settings-members', 'workspace', 'settings_nav_members', 'settings_desc_members'),
  card(
    'settings-company',
    'workspace',
    'ia_settings_card_company',
    'ia_settings_card_company_desc'
  ),
  card(
    'settings-projects',
    'workspace',
    'ia_settings_card_projects',
    'ia_settings_card_projects_desc'
  ),
  card(
    'settings-tenant-cli',
    'workspace',
    'ia_settings_card_tenant_cli',
    'ia_settings_card_tenant_cli_desc'
  ),
  card(
    'settings-reasoning',
    'agents',
    'ia_settings_card_reasoning',
    'ia_settings_card_reasoning_desc'
  ),
  card('settings-authority', 'agents', 'settings_nav_authority', 'settings_desc_authority'),
  card('setup-media', 'agents', 'settings_nav_voice', 'settings_desc_voice'),
  card('settings-engine', 'agents', 'ia_settings_card_engine', 'ia_settings_card_engine_desc'),
  card(
    'setup-notifications',
    'notifications',
    'settings_nav_notifications',
    'settings_desc_notifications'
  ),
  card('setup-services', 'connections', 'settings_nav_services', 'settings_desc_services'),
  card('settings-sso', 'connections', 'ia_settings_card_sso', 'ia_settings_card_sso_desc'),
  card('setup-plugins', 'connections', 'settings_nav_plugins', 'ia_settings_plugins_lead'),
  card('settings-recording', 'data', 'settings_nav_recording', 'settings_desc_recording'),
  card('settings-secrets', 'data', 'ia_settings_card_secrets', 'ia_settings_card_secrets_desc'),
  card('settings-budget', 'budget', 'ia_settings_card_budget', 'ia_settings_card_budget_desc'),
  card('settings-display', 'display', 'settings_nav_display', 'settings_desc_display'),
  card('settings-advanced', 'advanced', 'settings_nav_advanced', 'settings_desc_advanced'),
  card('settings-cli', 'advanced', 'ia_settings_card_cli', 'ia_settings_card_cli_desc'),
];

/**
 * Anchors inside cards that older links, the OAuth callback and readiness
 * rows still target; each resolves to the category that renders it.
 */
const NESTED_ANCHORS: Record<string, SettingsSectionId> = {
  'setup-management': 'advanced',
  'setup-governance': 'advanced',
  'setup-operations': 'advanced',
  'settings-invites': 'workspace',
  'settings-org-readiness': 'workspace',
  'settings-charter': 'agents',
  'settings-plugins': 'connections',
};

/** `#id` → the category that shows it (categories, cards and nested anchors). */
export function settingsCategoryOf(id: string): SettingsSectionId | null {
  const category = SETTINGS_SECTION_ORDER.find(
    (entry) => SETTINGS_SECTION_ELEMENT_ID[entry] === id
  );
  if (category) return category;
  return SETTINGS_CARDS.find((entry) => entry.id === id)?.category ?? NESTED_ANCHORS[id] ?? null;
}

/** Case- and width-insensitive match on the translated label, description and category. */
export function filterSettingsCards(
  query: string,
  translate: (key: FrontDeskMessageKey) => string,
  cards: readonly SettingsCard[] = SETTINGS_CARDS
): SettingsCard[] {
  const needle = query.normalize('NFKC').trim().toLowerCase();
  if (!needle) return [...cards];
  const words = needle.split(/\s+/);
  return cards.filter((entry) => {
    const text = [
      translate(entry.label),
      translate(entry.description),
      translate(SETTINGS_CATEGORIES[entry.category].label),
    ]
      .join(' ')
      .normalize('NFKC')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Maps a `/api/setup` diagnostic id to the category that fixes it. */
export const DIAGNOSTIC_SECTION: Record<string, SettingsSectionId> = {
  profile: 'workspace',
  avatar: 'agents',
  voice: 'agents',
  services: 'connections',
  notifications: 'notifications',
  reasoning: 'agents',
};

/** Checklist step → the category that completes it. */
export const CHECKLIST_SECTION = Object.fromEntries(
  SETUP_CHECKLIST_ORDER.map((step) => [
    step,
    settingsCategoryOf(SETUP_CHECKLIST_ANCHORS[step]) ?? 'start',
  ])
) as Record<SetupChecklistStepId, SettingsSectionId>;

export interface SettingsReadinessItem {
  /** A checklist step id or a `/api/setup` diagnostic id. */
  id: string;
  status: 'ok' | 'incomplete' | 'error';
}

/**
 * The order to visit categories on first run: the categories of unfinished
 * items come first, in the order the items are given (the checklist's
 * required order, then the other diagnostics), followed by the rest in
 * canonical order. Once everything is complete the canonical order is used.
 * The left nav never reorders; this drives the "next to open" pointer.
 */
export function orderSectionsForFirstRun(
  readiness: readonly SettingsReadinessItem[]
): SettingsSectionId[] {
  const pending: SettingsSectionId[] = [];
  for (const item of readiness) {
    if (item.status === 'ok') continue;
    const section =
      CHECKLIST_SECTION[item.id as SetupChecklistStepId] ?? DIAGNOSTIC_SECTION[item.id];
    if (section && !pending.includes(section)) pending.push(section);
  }
  if (pending.length === 0) return [...SETTINGS_SECTION_ORDER];
  return [...pending, ...SETTINGS_SECTION_ORDER.filter((id) => !pending.includes(id))];
}

/** An explicit empty saved selection is authoritative; only old receipts use defaults. */
export function resolveSelectedServices(
  catalog: ReadonlyArray<{ id: string; configured: boolean }>,
  persisted: readonly string[] | undefined,
  defaults: readonly string[]
): string[] {
  const selected =
    persisted === undefined
      ? catalog
          .filter((service) => service.configured || defaults.includes(service.id))
          .map((service) => service.id)
      : persisted;
  const allowed = new Set(catalog.map((service) => service.id));
  return [...new Set(selected)].filter((id) => allowed.has(id));
}
