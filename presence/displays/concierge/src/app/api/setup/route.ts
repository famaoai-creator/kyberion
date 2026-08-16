import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import {
  applyBrowserOnboarding,
  getInstalledReasoningMode,
  getBrowserOnboardingState,
  listAgentIdentities,
  listTenantProfileSlugs,
  loadNotificationPreferences,
  readTenantProfile,
  resolveActiveProfileRoot,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  saveBrowserOnboardingVoiceSample,
  secureIo,
  writeTenantProfile,
  withExecutionContext,
} from '@agent/core';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    const root = pathResolver.rootDir();
    const roles = JSON.parse(
      safeReadFile(path.join(root, 'knowledge/product/governance/surface-roles.json'), {
        encoding: 'utf8',
      }) as string
    ) as { roles: Array<Record<string, unknown>> };
    const surfaces = JSON.parse(
      safeReadFile(path.join(root, 'knowledge/product/governance/active-surfaces.json'), {
        encoding: 'utf8',
      }) as string
    ) as { surfaces: Array<Record<string, unknown>> };
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
      identity.tenant_slug || process.env.KYBERION_TENANT || 'default'
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
    const avatarRegistered = secureIo.withSensitivePathMediation(() => safeExistsSync(avatarPath));
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
          runtime_bound: Boolean(process.env.KYBERION_TENANT),
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

  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const action = String(form.get('action') || '');
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: t('api.file_required') }, { status: 400 });
      }
      if (file.size < 1 || file.size > 8 * 1024 * 1024) {
        return NextResponse.json({ ok: false, error: t('api.file_size') }, { status: 400 });
      }
      if (action === 'voice_sample') {
        const profileId = String(form.get('profile_id') || 'my-voice');
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
        const avatarSource = String(form.get('source') || 'upload');
        const profileRoot = resolveActiveProfileRoot();
        const avatarPath = path.join(profileRoot, 'avatar.png');
        withExecutionContext('sovereign_concierge', () =>
          secureIo.withSensitivePathMediation(() => {
            safeMkdir(profileRoot, { recursive: true });
            safeWriteFile(avatarPath, fileData);
            const identityPath = path.join(profileRoot, 'my-identity.json');
            const identity = safeExistsSync(identityPath)
              ? JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'))
              : { name: 'user', language: 'ja', interaction_style: 'Concierge' };
            identity.avatar_path = 'avatar.png';
            identity.avatar_source = avatarSource === 'camera' ? 'camera' : 'upload';
            identity.updated_at = new Date().toISOString();
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

    const body = await req.json();
    if (body?.action === 'save_management') {
      const tenantInput = body.tenant || {};
      const agentInput = body.agent || {};
      const activeSlug = String(
        tenantInput.slug || process.env.KYBERION_TENANT || 'default'
      ).trim();
      const profileRoot = resolveActiveProfileRoot();
      const identityPath = path.join(profileRoot, 'my-identity.json');
      const visionPath = path.join(profileRoot, 'my-vision.md');
      const agentPath = path.join(profileRoot, 'agent-identity.json');
      const result = withExecutionContext('sovereign_concierge', () =>
        secureIo.withSensitivePathMediation(() => {
          const currentIdentity = safeExistsSync(identityPath)
            ? JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'))
            : {};
          const currentTenant = readTenantProfile(activeSlug) || {
            tenant_slug: activeSlug,
            tenant_id: activeSlug,
            display_name: activeSlug,
            status: 'active' as const,
            assigned_role: 'owner',
          };
          const tenant = writeTenantProfile({
            ...currentTenant,
            tenant_slug: activeSlug,
            display_name: String(
              tenantInput.display_name || currentTenant.display_name || activeSlug
            ).trim(),
            assigned_role: String(
              tenantInput.assigned_role || currentTenant.assigned_role || 'owner'
            ).trim(),
            status:
              tenantInput.status === 'suspended' || tenantInput.status === 'archived'
                ? tenantInput.status
                : 'active',
          });
          const vision = String(body.vision || currentIdentity.vision || '').trim();
          const identity = {
            ...currentIdentity,
            ...(body.name ? { name: String(body.name).trim() } : {}),
            ...(body.primary_domain ? { primary_domain: String(body.primary_domain).trim() } : {}),
            tenant_slug: tenant.tenant_slug,
            vision,
            updated_at: new Date().toISOString(),
          };
          safeMkdir(profileRoot, { recursive: true });
          safeWriteFile(identityPath, JSON.stringify(identity, null, 2), { encoding: 'utf8' });
          safeWriteFile(visionPath, `# Sovereign Vision\n\n${vision}\n`, { encoding: 'utf8' });
          const currentAgent = safeExistsSync(agentPath)
            ? JSON.parse(String(safeReadFile(agentPath, { encoding: 'utf8' }) || '{}'))
            : {};
          const agentId = String(
            agentInput.agent_id || currentAgent.agent_id || 'sovereign-agent'
          ).trim();
          if (!/^[A-Za-z][A-Za-z0-9._-]{2,63}$/.test(agentId)) {
            throw new Error('agent_id must be 3-64 characters and start with a letter');
          }
          safeWriteFile(
            agentPath,
            JSON.stringify(
              {
                ...currentAgent,
                agent_id: agentId,
                display_name: String(
                  agentInput.display_name || currentAgent.display_name || agentId
                ).trim(),
                provider:
                  String(agentInput.provider || currentAgent.provider || '').trim() || undefined,
                model_id:
                  String(agentInput.model_id || currentAgent.model_id || '').trim() || undefined,
                owner: String(identity.name || currentAgent.owner || 'user'),
                updated_at: new Date().toISOString(),
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
    const draft = structuredClone(body.draft) as {
      [key: string]: unknown;
      voice?: { enabled?: boolean; sample_refs?: unknown[] };
    };
    if (draft.voice?.enabled && Array.isArray(draft.voice.sample_refs)) {
      draft.voice.sample_refs = draft.voice.sample_refs.map((sampleRef: unknown) => {
        const value = String(sampleRef || '');
        return path.isAbsolute(value) ? value : pathResolver.rootResolve(value);
      });
    }
    const result = await secureIo.withSensitivePathMediation(() => applyBrowserOnboarding(draft));
    return NextResponse.json({ ok: true, onboarding: result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
