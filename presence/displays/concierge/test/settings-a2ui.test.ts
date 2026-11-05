import { describe, expect, it } from 'vitest';
import { validateA2UIMessage } from '@agent/core/a2ui';
import { A2UI_BASE_CATALOG_ID } from '@agent/core/surface/a2ui-catalog';
import { buildConciergeHeadlessManifest } from '../src/lib/headless-projections';
import { buildConciergeSettingsA2UI } from '../src/lib/settings-a2ui';
import { conciergeText, type ConciergeMessageKey } from '../src/lib/i18n';

const t = (key: ConciergeMessageKey) => conciergeText(key, 'en');

const SETUP = {
  diagnostics: [
    { id: 'profile', status: 'incomplete', action: { type: 'navigate', target: '#setup-profile' } },
    { id: 'avatar', status: 'ok', action: { type: 'navigate', target: '#setup-media' } },
    { id: 'voice', status: 'ok', action: { type: 'navigate', target: '#setup-media' } },
    {
      id: 'services',
      status: 'incomplete',
      action: { type: 'navigate', target: '#setup-services' },
    },
    {
      id: 'notifications',
      status: 'ok',
      action: { type: 'navigate', target: '#setup-notifications' },
    },
    { id: 'reasoning', status: 'ok', command: 'pnpm reasoning:setup' },
  ],
  service_catalog: [
    { id: 'slack', label: 'Slack', auth: 'OAuth + secret', configured: true },
    { id: 'github', label: 'GitHub', auth: 'OAuth + secret', configured: false },
  ],
  profile: { name: 'Moto', tenant_slug: 'famao-ai', onboarding_complete: false },
  tenant: { active_slug: 'famao-ai' },
  reasoning_mode: 'claude-cli',
} as const;

describe('Concierge settings A2UI projection', () => {
  it('publishes a settings resource with read and a2ui operations', () => {
    const manifest = buildConciergeHeadlessManifest();
    expect(manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'settings',
          query_path: '/api/headless/settings',
          a2ui_path: '/api/headless/a2ui/settings',
        }),
      ])
    );
    const opIds = manifest.operations.map((operation) => operation.operation_id);
    expect(opIds).toContain('concierge.settings.read');
    expect(opIds).toContain('concierge.settings.a2ui');
    expect(manifest.operations.every((operation) => operation.effect === 'read')).toBe(true);
  });

  it('emits schema-valid kyberion-base messages for the settings surface', () => {
    const messages = buildConciergeSettingsA2UI(SETUP, 'en', t);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.createSurface).toMatchObject({
      surfaceId: 'concierge-settings',
      catalogId: A2UI_BASE_CATALOG_ID,
    });
    for (const message of messages) expect(() => validateA2UIMessage(message)).not.toThrow();
  });

  it('projects nav groups, readiness rows, integrations and the next action', () => {
    const components =
      buildConciergeSettingsA2UI(SETUP, 'en', t)[1]?.updateComponents?.components ?? [];
    const byId = new Map(components.map((component) => [component.id, component]));

    const nav = byId.get('settings-nav');
    expect(nav?.type).toBe('ui:settings-nav');
    const groups = (nav?.props.groups ?? []) as Array<{
      items: Array<{ id: string; status?: string; href: string }>;
    }>;
    const items = groups.flatMap((group) => group.items);
    // MSN-SHELL-IA: the nav lists the nine categories; a category takes the
    // worst status of the diagnostics it fixes.
    expect(items.map((item) => item.id)).toContain('start');
    expect(items.find((item) => item.id === 'workspace')?.status).toBe('needs_setup');
    expect(items.find((item) => item.id === 'connections')?.status).toBe('needs_setup');
    expect(items.find((item) => item.id === 'agents')?.status).toBe('done');
    expect(items.every((item) => item.href.startsWith('/settings#'))).toBe(true);

    const readiness = byId.get('settings-readiness');
    expect(readiness?.type).toBe('ui:settings-group');
    expect(readiness?.children).toEqual(
      SETUP.diagnostics.map((diag) => `settings-diag-${diag.id}`)
    );
    expect(byId.get('settings-diag-services')?.type).toBe('ui:setting-row');
    expect(byId.get('settings-diag-services')?.children).toEqual(['settings-diag-services-status']);
    expect(byId.get('settings-diag-services-status')?.type).toBe('ui:status-pill');
    expect(byId.get('settings-diag-services-status')?.props.status).toBe('needs_setup');
    expect(byId.get('settings-diag-avatar-status')?.props.status).toBe('done');

    expect(byId.get('settings-service-slack')?.props.state).toBe('connected');
    expect(byId.get('settings-service-github')?.props.state).toBe('disconnected');
    expect(byId.get('settings-service-github')?.props.actions).toEqual([
      expect.objectContaining({ href: '/settings#setup-services' }),
    ]);

    const next = byId.get('settings-next-action');
    expect(next?.type).toBe('ui:next-action');
    expect(next?.props.primary).toEqual(
      expect.objectContaining({ href: '/settings#setup-profile' })
    );
  });

  it('carries the scoped settings summary in the data model', () => {
    const data = buildConciergeSettingsA2UI(SETUP, 'en', t)[2]?.updateDataModel?.data as {
      diagnostics: unknown[];
      services: Array<{ id: string; configured: boolean }>;
      tenant: { active_slug: string | null };
    };
    expect(data.diagnostics).toHaveLength(6);
    expect(data.services).toEqual([
      { id: 'slack', configured: true },
      { id: 'github', configured: false },
    ]);
    expect(data.tenant.active_slug).toBe('famao-ai');
  });

  it('omits the next action when every diagnostic is ok', () => {
    const allOk = {
      ...SETUP,
      diagnostics: SETUP.diagnostics.map((diag) => ({ ...diag, status: 'ok' as const })),
    };
    const components =
      buildConciergeSettingsA2UI(allOk, 'en', t)[1]?.updateComponents?.components ?? [];
    expect(components.some((component) => component.id === 'settings-next-action')).toBe(false);
  });
});
