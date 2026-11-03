import type { A2UIComponent, A2UIMessage } from '@agent/core/a2ui';
import { A2UI_BASE_CATALOG_ID } from '@agent/core/surface/a2ui-catalog';
import { createSettingsMenu } from '../app/settings/settings-menu';
import type { ConciergeLocale } from './i18n';
import { frontDeskText } from './i18n';
import type { ConciergeMessageKey } from './i18n';
import type { SetupTranslator } from './setup-state';
import { DIAGNOSTIC_SECTION, type SettingsSectionId } from './settings-view';

/**
 * Settings A2UI projection (`concierge.settings.a2ui`): the concierge
 * `/settings` surface expressed in the shared `kyberion-base` catalog so any
 * A2UI host (hearing, headless client) renders the same nav, readiness and
 * service connection state — the UI-01c settings vocabulary the HTML page
 * itself already uses through `@agent/shared-ui`.
 */

type Diagnostic = {
  id: string;
  status: 'ok' | 'incomplete' | 'error';
  action?: { type: 'navigate'; target: string };
  command?: string;
};

export type SettingsProjectionInput = {
  diagnostics?: readonly Diagnostic[];
  service_catalog?: ReadonlyArray<{
    id: string;
    label: string;
    auth?: string;
    configured: boolean;
  }>;
  profile?: { name?: string; tenant_slug?: string; onboarding_complete?: boolean };
  tenant?: { active_slug?: string };
  reasoning_mode?: string;
};

const DIAG_LABEL: Record<string, ConciergeMessageKey> = {
  profile: 'setup.diag.profile',
  avatar: 'setup.diag.avatar',
  voice: 'setup.diag.voice',
  services: 'setup.diag.services',
  notifications: 'setup.diag.notifications',
  reasoning: 'setup.diag.reasoning',
};

function diagnosticStatus(status: Diagnostic['status']): string {
  if (status === 'ok') return 'done';
  if (status === 'error') return 'error';
  return 'needs_setup';
}

function diagnosticStatusLabel(status: Diagnostic['status'], t: SetupTranslator): string {
  if (status === 'error') return t('setup.diag_error');
  return status === 'ok' ? t('setup.completed') : t('setup.incomplete');
}

export function buildConciergeSettingsA2UI(
  setup: SettingsProjectionInput,
  locale: ConciergeLocale,
  t: SetupTranslator
): A2UIMessage[] {
  const surfaceId = 'concierge-settings';
  const diagnostics = Array.isArray(setup.diagnostics) ? setup.diagnostics : [];
  const services = Array.isArray(setup.service_catalog) ? setup.service_catalog : [];
  const activeTenant = String(setup.tenant?.active_slug || setup.profile?.tenant_slug || '');

  const sectionStatus = new Map<SettingsSectionId, string>();
  for (const diagnostic of diagnostics) {
    const section = DIAGNOSTIC_SECTION[diagnostic.id];
    if (!section) continue;
    const status = diagnosticStatus(diagnostic.status);
    // Worst wins when several diagnostics map to one section.
    const rank = { done: 0, needs_setup: 1, error: 2 } as const;
    const previous = sectionStatus.get(section);
    if (!previous || rank[status as keyof typeof rank] > rank[previous as keyof typeof rank]) {
      sectionStatus.set(section, status);
    }
  }

  const groups = createSettingsMenu(locale, {}).map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      icon: item.icon,
      href: `/settings${item.href}`,
      ...(sectionStatus.has(item.id as SettingsSectionId)
        ? { status: sectionStatus.get(item.id as SettingsSectionId) }
        : {}),
    })),
  }));

  const readinessRows: A2UIComponent[] = [];
  for (const diagnostic of diagnostics) {
    const labelKey = DIAG_LABEL[diagnostic.id];
    const label = labelKey ? t(labelKey) : diagnostic.id;
    const pillId = `settings-diag-${diagnostic.id}-status`;
    readinessRows.push({
      id: `settings-diag-${diagnostic.id}`,
      type: 'ui:setting-row' as const,
      props: {
        label,
        ...(diagnostic.status !== 'ok' && diagnostic.command
          ? { description: `\`${diagnostic.command}\`` }
          : {}),
        ...(diagnostic.status === 'error' ? { tone: 'danger' } : {}),
      },
      children: [pillId],
    });
    readinessRows.push({
      id: pillId,
      type: 'ui:status-pill',
      props: {
        status: diagnosticStatus(diagnostic.status),
        label: diagnosticStatusLabel(diagnostic.status, t),
      },
    });
  }

  const serviceItems: A2UIComponent[] = services.map((service) => ({
    id: `settings-service-${service.id}`,
    type: 'ui:integration-item' as const,
    props: {
      title: service.label,
      state: service.configured ? 'connected' : 'disconnected',
      ...(service.auth ? { detail: service.auth } : {}),
      ...(!service.configured
        ? {
            actions: [
              {
                label: frontDeskText('settings_service_connect', locale),
                href: '/settings#setup-services',
              },
            ],
          }
        : {}),
    },
  }));

  const firstIncomplete = diagnostics.find((diagnostic) => diagnostic.status !== 'ok');
  const components: A2UIComponent[] = [
    {
      id: 'settings-header',
      type: 'ui:page-header',
      props: {
        title: frontDeskText('nav_settings', locale),
        ...(activeTenant ? { subtitle: activeTenant } : {}),
      },
    },
    {
      id: 'settings-nav',
      type: 'ui:settings-nav',
      props: { label: frontDeskText('nav_settings', locale), groups },
    },
    {
      id: 'settings-readiness',
      type: 'ui:settings-group',
      props: { title: t('setup.onboarding') },
      children: diagnostics.map((diagnostic) => `settings-diag-${diagnostic.id}`),
    },
    ...readinessRows,
    {
      id: 'settings-services',
      type: 'ui:settings-group',
      props: { title: frontDeskText('settings_nav_services', locale) },
      children: serviceItems.map((item) => item.id),
    },
    ...serviceItems,
  ];

  if (firstIncomplete) {
    const labelKey = DIAG_LABEL[firstIncomplete.id];
    const target = firstIncomplete.action?.target;
    components.push({
      id: 'settings-next-action',
      type: 'ui:next-action',
      props: {
        eyebrow: 'Kyberion',
        title: labelKey ? t(labelKey) : firstIncomplete.id,
        primary: target
          ? {
              label: frontDeskText('settings_change', locale),
              href: `/settings${target}`,
            }
          : { label: frontDeskText('nav_settings', locale), href: '/settings' },
      },
    });
  }

  return [
    {
      createSurface: {
        surfaceId,
        catalogId: A2UI_BASE_CATALOG_ID,
        title: frontDeskText('nav_settings', locale),
      },
    },
    { updateComponents: { surfaceId, components } },
    {
      updateDataModel: {
        surfaceId,
        data: {
          diagnostics,
          services: services.map((service) => ({
            id: service.id,
            configured: service.configured,
          })),
          reasoning_mode: setup.reasoning_mode ?? null,
          tenant: { active_slug: activeTenant || null },
          profile: {
            name: setup.profile?.name ?? null,
            onboarding_complete: setup.profile?.onboarding_complete ?? null,
          },
        },
      },
    },
  ];
}
