import * as path from 'node:path';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { getBrowserOnboardingState } from '@agent/core/browser/browser-onboarding';
import { getInstalledReasoningMode } from '@agent/core/reasoning/reasoning-bootstrap';
import { resolveRuntimeModelId } from '@agent/core/tool/runtime-model-defaults';
import { listAgentIdentities } from '@agent/core/agent/agent-identity';
import {
  listTenantProfileSlugs,
  readTenantProfile,
} from '@agent/core/organization/tenant-registry';
import { loadNotificationPreferences } from '@agent/core/surface/operator-notifications';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { pathResolver } from '@agent/core/path-resolver';
import { loadSurfaceManifest } from '@agent/core/surface/surface-runtime';
import { loadSurfaceRoleCatalog } from '@agent/core/surface/surface-role-catalog';
import * as secureIo from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import type { ConciergeMessageKey } from './i18n';
import { visibleConnections } from './connection-view';
import { resolveConciergeDecidedBy } from './front-desk-member';
import type { ConciergeViewerContext } from './viewer-context';
import { resolveConciergeInstallationAccess } from './installation-access';

export type SetupTranslator = (
  key: ConciergeMessageKey,
  params?: Record<string, string | number>
) => string;

export function resolveExistingProfileFile(filePath: string): string | null {
  try {
    const safePath = secureIo.assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    return secureIo.safeExistsSync(safePath) && secureIo.safeLstat(safePath).isFile()
      ? safePath
      : null;
  } catch {
    return null;
  }
}

/**
 * The `/api/setup` settings projection — one assembly shared by the HTML page
 * (via the setup route) and the headless/A2UI settings endpoints, so every
 * surface reports the same readiness and connection state.
 */
export function buildConciergeSetupState(
  viewer: ConciergeViewerContext,
  t: SetupTranslator
): Record<string, unknown> {
  const roles = loadSurfaceRoleCatalog();
  const surfaces = loadSurfaceManifest();
  let reasoning = 'unknown';
  try {
    reasoning = String(getInstalledReasoningMode() || 'not-installed');
  } catch {
    reasoning = 'not-installed';
  }
  const onboarding = getBrowserOnboardingState();
  const profileRoot = resolveActiveProfileRoot();
  // The personal profile is the installation owner's: anyone else sees the
  // settings structure without the owner's identity, vision or voice data.
  const installation = resolveConciergeInstallationAccess(viewer, 'read');
  const identity = (installation.allowed ? onboarding.identity || {} : {}) as Record<
    string,
    unknown
  >;
  const avatarPath = path.join(profileRoot, 'avatar.png');
  const activeVoiceSampleRoot = path.resolve(profileRoot, 'voice', 'samples');
  const activeTenantSlug = String(
    identity.tenant_slug || getRegisteredEnvText('KYBERION_TENANT') || 'default'
  );
  const tenantCatalog = withExecutionContext('sovereign_concierge', () =>
    listTenantProfileSlugs().flatMap((slug) => {
      const profile = readTenantProfile(slug);
      return profile
        ? [
            {
              tenant_slug: profile.tenant_slug,
              tenant_id: profile.tenant_id || profile.tenant_slug,
              display_name: profile.display_name,
              status: profile.status,
              assigned_role: profile.assigned_role,
            },
          ]
        : [];
    })
  );
  const managedAgents = listAgentIdentities().map((agent) => ({
    nhi_id: agent.nhi_id,
    kind: agent.kind,
    display_name: agent.display_name,
    lifecycle_status: agent.lifecycle_status,
    accountable_human_id: agent.accountable_human_id,
    organization_id: agent.affiliation.organization_id,
    provider_hint: agent.provider_hint || '',
    model_hint: agent.model_hint || '',
  }));
  const allConnectionRecords = Array.isArray(onboarding.service_bindings)
    ? onboarding.service_bindings
    : [];
  // Connections are owned (person / organization / operator): the viewer sees
  // only their own and their organizations', and "connected" reflects only those.
  const viewerMember = withExecutionContext('sovereign_concierge', () =>
    resolveConciergeDecidedBy(viewer)
  );
  const connections = visibleConnections(allConnectionRecords, {
    loopback: viewer.source === 'loopback',
    ...(viewerMember ? { memberId: viewerMember.id.replace(/^user:/, '') } : {}),
    tenantSlugs: viewer.tenantSlugs,
  });
  const configuredServices = new Set(connections.map((connection) => connection.service_id));
  const serviceCatalog = [
    { id: 'google-workspace', label: t('service.google'), auth: t('auth.oauth') },
    { id: 'microsoft-365', label: t('service.microsoft'), auth: t('auth.oauth') },
    { id: 'notion', label: t('service.notion'), auth: t('auth.oauth') },
    { id: 'slack', label: t('service.slack'), auth: t('auth.oauth_secret') },
    { id: 'github', label: t('service.github'), auth: t('auth.oauth_secret') },
    { id: 'browser', label: t('service.browser'), auth: t('auth.session') },
    { id: 'voice-hub', label: t('service.voice'), auth: t('auth.local_consent') },
  ].map((service) => ({
    ...service,
    configured: configuredServices.has(service.id),
  }));

  const onboardingComplete =
    (onboarding.onboarding as Record<string, unknown> | null)?.status === 'complete';
  const avatarRegistered = secureIo.withSensitivePathMediation(
    () => resolveExistingProfileFile(avatarPath) !== null
  );
  const voiceProfileCount = Array.isArray(onboarding.voice_profiles)
    ? onboarding.voice_profiles.length
    : 0;
  const reasoningReady =
    reasoning !== 'not-installed' && reasoning !== 'stub' && reasoning !== 'unknown';
  const notificationPreferences = withExecutionContext('sovereign_concierge', () =>
    secureIo.withSensitivePathMediation(() => loadNotificationPreferences())
  );

  // CS-03: every incomplete item carries a machine-actionable descriptor.
  // `action: navigate` jumps to the in-page section that fixes it; only the
  // reasoning backend has no in-app fix, so it degrades honestly to polite
  // guidance with the terminal command kept visually secondary in the UI.
  const diagnostics: Array<{
    id: string;
    status: 'ok' | 'incomplete' | 'error';
    action?: { type: 'navigate'; target: string };
    command?: string;
  }> = [
    {
      id: 'profile',
      status: onboardingComplete ? 'ok' : 'incomplete',
      action: { type: 'navigate', target: '#setup-profile' },
    },
    {
      id: 'avatar',
      status: avatarRegistered ? 'ok' : 'incomplete',
      action: { type: 'navigate', target: '#setup-media' },
    },
    {
      id: 'voice',
      status: voiceProfileCount > 0 ? 'ok' : 'incomplete',
      action: { type: 'navigate', target: '#setup-media' },
    },
    {
      id: 'services',
      status: configuredServices.size > 0 ? 'ok' : 'incomplete',
      action: { type: 'navigate', target: '#setup-services' },
    },
    {
      id: 'notifications',
      status: notificationPreferences.default_channel ? 'ok' : 'incomplete',
      action: { type: 'navigate', target: '#setup-notifications' },
    },
    {
      id: 'reasoning',
      status: reasoningReady ? 'ok' : 'incomplete',
      command: 'pnpm reasoning:setup',
    },
  ];

  return {
    installation_access: installation.allowed
      ? { owner: true }
      : { owner: false, error_code: installation.code },
    surface_roles: roles.roles,
    active_surfaces: surfaces.surfaces.map((entry) => ({
      id: entry.id,
      port: entry.port,
      enabled: entry.enabled !== false,
    })),
    reasoning_mode: reasoning,
    model_tiers: {
      fast: resolveRuntimeModelId('anthropic-fast'),
      standard: resolveRuntimeModelId('anthropic-standard'),
      deep: resolveRuntimeModelId('anthropic-default'),
    },
    profile: {
      name: String(identity.name || ''),
      language: String(identity.language || 'ja'),
      interaction_style: String(identity.interaction_style || 'Concierge'),
      primary_domain: String(identity.primary_domain || ''),
      tenant_slug: activeTenantSlug,
      vision: String(identity.vision || (installation.allowed ? onboarding.vision : '') || ''),
      agent_id: String(
        (onboarding.agent_identity as Record<string, unknown> | null)?.agent_id || 'sovereign-agent'
      ),
      onboarding_complete: onboardingComplete,
      avatar_registered: avatarRegistered,
      avatar_source: String(identity.avatar_source || ''),
      voice_profiles:
        installation.allowed && Array.isArray(onboarding.voice_profiles)
          ? onboarding.voice_profiles.map((voice) => ({
              profile_id: String((voice as Record<string, unknown>).profile_id || ''),
              display_name: String((voice as Record<string, unknown>).display_name || ''),
              sample_count: Array.isArray((voice as Record<string, unknown>).sample_refs)
                ? ((voice as Record<string, unknown>).sample_refs as unknown[]).length
                : 0,
              sample_refs: Array.isArray((voice as Record<string, unknown>).sample_refs)
                ? ((voice as Record<string, unknown>).sample_refs as unknown[])
                    .map((sampleRef) => path.resolve(String(sampleRef)))
                    .filter(
                      (sampleRef) =>
                        sampleRef === activeVoiceSampleRoot ||
                        sampleRef.startsWith(`${activeVoiceSampleRoot}${path.sep}`)
                    )
                    .map((sampleRef) => pathResolver.toRepoRelative(sampleRef))
                : [],
            }))
          : [],
    },
    tenant: {
      active_slug: activeTenantSlug,
      runtime_bound: Boolean(getRegisteredEnvText('KYBERION_TENANT')),
      catalog: tenantCatalog,
    },
    agent_management: {
      configured: onboarding.agent_identity || null,
      durable_identities: managedAgents,
    },
    service_catalog: serviceCatalog,
    ...(Array.isArray((onboarding.onboarding as { services?: unknown[] } | null)?.services)
      ? {
          selected_services: (onboarding.onboarding as { services: unknown[] }).services.flatMap(
            (service) => {
              const id =
                service && typeof service === 'object'
                  ? (service as { service_id?: unknown }).service_id
                  : undefined;
              return typeof id === 'string' && serviceCatalog.some((entry) => entry.id === id)
                ? [id]
                : [];
            }
          ),
        }
      : {}),
    connections,
    providers: onboarding.providers,
    diagnostics,
    // ceo-ux.md: no internal execution vocabulary (pipeline IDs, shell
    // commands) in capability copy — capabilities either link to an
    // in-app section or are available through the conversation dock.
    capabilities: [
      { id: 'approvals', label: t('cap.approvals'), status: 'ready', href: '/' },
      { id: 'schedule', label: t('cap.schedule'), status: 'ready' },
      { id: 'email', label: t('cap.email'), status: 'ready' },
      { id: 'voice', label: t('cap.voice'), status: 'ready' },
      { id: 'device', label: t('cap.device'), status: 'ready', href: '#setup-media' },
    ],
  };
}
