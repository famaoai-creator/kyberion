import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import { getRegisteredEnvText, nowIso, readJson } from '@agent/core/foundation';
import {
  applyBrowserOnboarding,
  getBrowserOnboardingState,
  saveBrowserOnboardingVoiceSample,
} from '@agent/core/browser-onboarding';
import { getInstalledReasoningMode } from '@agent/core/reasoning-bootstrap';
import { listAgentIdentities } from '@agent/core/agent-identity';
import {
  listTenantProfileSlugs,
  readTenantProfile,
  writeTenantProfile,
} from '@agent/core/tenant-registry';
import { loadNotificationPreferences } from '@agent/core/operator-notifications';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { pathResolver } from '@agent/core/path-resolver';
import { loadSurfaceManifest } from '@agent/core/surface-runtime';
import { loadSurfaceRoleCatalog } from '@agent/core/surface-role-catalog';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import * as secureIo from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { resolveConciergeViewer } from '../../../lib/viewer-context';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';
import {
  optionalSetupBoolean,
  optionalSetupObject,
  optionalSetupString,
  optionalSetupStringArray,
  requireKnownFormKeys,
  requireKnownRequestKeys,
  requireSetupObject,
  SetupInputError,
  type SetupInputObject,
} from './setup-input';

export const dynamic = 'force-dynamic';

function resolveExistingProfileFile(filePath: string): string | null {
  try {
    const safePath = secureIo.assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    return secureIo.safeExistsSync(safePath) && secureIo.safeLstat(safePath).isFile()
      ? safePath
      : null;
  } catch {
    return null;
  }
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
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
    const identity = (onboarding.identity || {}) as Record<string, unknown>;
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
      organization_id: agent.affiliation.organization_id,
      provider_hint: agent.provider_hint || '',
      model_hint: agent.model_hint || '',
    }));
    const connectionRecords = Array.isArray(onboarding.service_bindings)
      ? onboarding.service_bindings
      : [];
    const configuredServices = new Set(
      connectionRecords
        .map((record) => (record as Record<string, unknown>).service_id)
        .filter((value): value is string => typeof value === 'string')
    );
    const serviceCatalog = [
      { id: 'google-workspace', label: t('service.google'), auth: t('auth.oauth') },
      { id: 'microsoft-365', label: t('service.microsoft'), auth: t('auth.oauth') },
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

    return NextResponse.json({
      ok: true,
      setup: {
        surface_roles: roles.roles,
        active_surfaces: surfaces.surfaces.map((entry) => ({
          id: entry.id,
          port: entry.port,
          enabled: entry.enabled !== false,
        })),
        reasoning_mode: reasoning,
        model_tiers: { fast: 'haiku', standard: 'sonnet', deep: 'opus' },
        profile: {
          name: String(identity.name || ''),
          language: String(identity.language || 'ja'),
          interaction_style: String(identity.interaction_style || 'Concierge'),
          primary_domain: String(identity.primary_domain || ''),
          tenant_slug: activeTenantSlug,
          vision: String(identity.vision || onboarding.vision || ''),
          agent_id: String(
            (onboarding.agent_identity as Record<string, unknown> | null)?.agent_id ||
              'sovereign-agent'
          ),
          onboarding_complete: onboardingComplete,
          avatar_registered: avatarRegistered,
          avatar_source: String(identity.avatar_source || ''),
          voice_profiles: Array.isArray(onboarding.voice_profiles)
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
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  try {
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      try {
        requireKnownFormKeys(form, ['action', 'file', 'profile_id', 'source']);
      } catch {
        return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
      }
      const actionValue = form.get('action');
      if (actionValue !== null && typeof actionValue !== 'string') {
        return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
      }
      const action = actionValue || '';
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: t('api.file_required') }, { status: 400 });
      }
      if (file.size < 1 || file.size > 8 * 1024 * 1024) {
        return NextResponse.json({ ok: false, error: t('api.file_size') }, { status: 400 });
      }
      if (action === 'voice_sample') {
        const profileIdValue = form.get('profile_id');
        if (profileIdValue !== null && typeof profileIdValue !== 'string') {
          return NextResponse.json(
            { ok: false, error: t('api.onboarding_input') },
            { status: 400 }
          );
        }
        const profileId = profileIdValue || 'my-voice';
        const result = saveBrowserOnboardingVoiceSample({
          profileId,
          contentType: file.type,
          data: Buffer.from(await file.arrayBuffer()),
        });
        return NextResponse.json({
          ok: true,
          sample: { ...result, sample_ref: pathResolver.toRepoRelative(result.sample_ref) },
        });
      }
      if (action === 'avatar') {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
          return NextResponse.json({ ok: false, error: t('api.image_type') }, { status: 400 });
        }
        const fileData = Buffer.from(await file.arrayBuffer());
        const sourceValue = form.get('source');
        if (sourceValue !== null && typeof sourceValue !== 'string') {
          return NextResponse.json(
            { ok: false, error: t('api.onboarding_input') },
            { status: 400 }
          );
        }
        const avatarSource = sourceValue || 'upload';
        const profileRoot = resolveActiveProfileRoot();
        const avatarPath = path.join(profileRoot, 'avatar.png');
        withExecutionContext('sovereign_concierge', () =>
          secureIo.withSensitivePathMediation(() => {
            safeMkdir(profileRoot, { recursive: true });
            safeWriteFile(avatarPath, fileData);
            const identityPath = path.join(profileRoot, 'my-identity.json');
            const safeIdentityPath = resolveExistingProfileFile(identityPath);
            const identity = safeIdentityPath
              ? readJson<Record<string, unknown>>(safeIdentityPath)
              : { name: 'user', language: 'ja', interaction_style: 'Concierge' };
            identity.avatar_path = 'avatar.png';
            identity.avatar_source = avatarSource === 'camera' ? 'camera' : 'upload';
            identity.updated_at = nowIso();
            safeWriteFile(identityPath, JSON.stringify(identity, null, 2), { encoding: 'utf8' });
          })
        );
        return NextResponse.json({ ok: true, avatar_path: 'avatar.png' });
      }
      return NextResponse.json(
        { ok: false, error: t('api.unknown_action', { action }) },
        { status: 400 }
      );
    }

    let body: SetupInputObject;
    try {
      body = requireSetupObject(await req.json(), 'request body');
      const allowedKeys =
        body.action === 'save_management'
          ? ['action', 'tenant', 'agent', 'vision', 'name', 'primary_domain']
          : body.action === 'apply_onboarding'
            ? ['action', 'draft']
            : ['action'];
      requireKnownRequestKeys(body, allowedKeys);
    } catch {
      return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
    }
    if (body?.action === 'save_management') {
      const tenantInput = optionalSetupObject(body, 'tenant') || {};
      const agentInput = optionalSetupObject(body, 'agent') || {};
      requireKnownRequestKeys(
        tenantInput,
        ['slug', 'display_name', 'assigned_role', 'status'],
        'tenant'
      );
      requireKnownRequestKeys(
        agentInput,
        ['agent_id', 'display_name', 'provider', 'model_id'],
        'agent'
      );
      const requestedSlug = optionalSetupString(tenantInput, 'slug');
      const activeSlug = (
        requestedSlug ||
        getRegisteredEnvText('KYBERION_TENANT') ||
        'default'
      ).trim();
      const displayNameInput = optionalSetupString(tenantInput, 'display_name');
      const assignedRoleInput = optionalSetupString(tenantInput, 'assigned_role');
      const statusInput = optionalSetupString(tenantInput, 'status');
      if (statusInput && !['active', 'suspended', 'archived'].includes(statusInput)) {
        throw new SetupInputError('tenant.status must be active, suspended, or archived');
      }
      const visionInput = optionalSetupString(body, 'vision');
      const nameInput = optionalSetupString(body, 'name');
      const primaryDomainInput = optionalSetupString(body, 'primary_domain');
      const agentIdInput = optionalSetupString(agentInput, 'agent_id');
      const agentDisplayNameInput = optionalSetupString(agentInput, 'display_name');
      const providerInput = optionalSetupString(agentInput, 'provider');
      const modelIdInput = optionalSetupString(agentInput, 'model_id');
      const profileRoot = resolveActiveProfileRoot();
      const identityPath = path.join(profileRoot, 'my-identity.json');
      const visionPath = path.join(profileRoot, 'my-vision.md');
      const agentPath = path.join(profileRoot, 'agent-identity.json');
      const result = withExecutionContext('sovereign_concierge', () =>
        secureIo.withSensitivePathMediation(() => {
          const safeIdentityPath = resolveExistingProfileFile(identityPath);
          const currentIdentity = safeIdentityPath
            ? readJson<Record<string, unknown>>(safeIdentityPath)
            : {};
          const currentTenant = readTenantProfile(activeSlug) || {
            tenant_slug: activeSlug,
            tenant_id: activeSlug,
            display_name: activeSlug,
            status: 'active' as const,
            assigned_role: 'owner',
          };
          const safeAgentPath = resolveExistingProfileFile(agentPath);
          const currentAgent = safeAgentPath
            ? readJson<Record<string, unknown>>(safeAgentPath)
            : {};
          const agentId = (
            agentIdInput || String(currentAgent.agent_id || 'sovereign-agent')
          ).trim();
          if (!/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(agentId)) {
            throw new Error('agent_id must be 3-64 characters and start with a letter');
          }
          const tenant = writeTenantProfile({
            ...currentTenant,
            tenant_slug: activeSlug,
            display_name: (
              displayNameInput || String(currentTenant.display_name || activeSlug)
            ).trim(),
            assigned_role: (
              assignedRoleInput || String(currentTenant.assigned_role || 'owner')
            ).trim(),
            status:
              statusInput === 'suspended' || statusInput === 'archived' ? statusInput : 'active',
          });
          const vision = (visionInput ?? String(currentIdentity.vision || '')).trim();
          const updatedAt = nowIso();
          const identity = {
            ...currentIdentity,
            ...(nameInput ? { name: nameInput.trim() } : {}),
            ...(primaryDomainInput ? { primary_domain: primaryDomainInput.trim() } : {}),
            tenant_slug: tenant.tenant_slug,
            vision,
            updated_at: updatedAt,
          };
          safeMkdir(profileRoot, { recursive: true });
          safeWriteFile(identityPath, JSON.stringify(identity, null, 2), { encoding: 'utf8' });
          safeWriteFile(visionPath, `# Sovereign Vision\n\n${vision}\n`, { encoding: 'utf8' });
          safeWriteFile(
            agentPath,
            JSON.stringify(
              {
                ...currentAgent,
                agent_id: agentId,
                display_name: (
                  agentDisplayNameInput || String(currentAgent.display_name || agentId)
                ).trim(),
                provider:
                  (providerInput || String(currentAgent.provider || '')).trim() || undefined,
                model_id: (modelIdInput || String(currentAgent.model_id || '')).trim() || undefined,
                owner: String(identity.name || currentAgent.owner || 'user'),
                updated_at: updatedAt,
              },
              null,
              2
            ),
            { encoding: 'utf8' }
          );
          return { tenant, agent_id: agentId };
        })
      );
      return NextResponse.json({ ok: true, management: result });
    }
    if (body?.action !== 'apply_onboarding' || !body?.draft) {
      return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
    }
    const draft = structuredClone(requireSetupObject(body.draft, 'draft')) as SetupInputObject;
    const voice = optionalSetupObject(draft, 'voice');
    const voiceEnabled = voice ? optionalSetupBoolean(voice, 'enabled') : undefined;
    const sampleRefs = voice ? optionalSetupStringArray(voice, 'sample_refs') : undefined;
    if (voice && voiceEnabled && sampleRefs) {
      voice.sample_refs = sampleRefs.map((value) => {
        return path.isAbsolute(value) ? value : pathResolver.rootResolve(value);
      });
    }
    const result = await secureIo.withSensitivePathMediation(() => applyBrowserOnboarding(draft));
    return NextResponse.json({ ok: true, onboarding: result });
  } catch (error) {
    if (error instanceof SetupInputError) {
      return NextResponse.json({ ok: false, error: t('api.onboarding_input') }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
