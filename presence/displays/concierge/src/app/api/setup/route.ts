import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import { nowIso } from '@agent/core/foundation';
import {
  applyBrowserOnboarding,
  applyBrowserOnboardingSettingsPatch,
  saveBrowserOnboardingVoiceSample,
} from '@agent/core/browser/browser-onboarding';
import { readTenantProfile, writeTenantProfile } from '@agent/core/organization/tenant-registry';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
} from '@agent/core/personal-identity-reader';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import * as secureIo from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { buildConciergeSetupState, resolveExistingProfileFile } from '../../../lib/setup-state';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';
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

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    return NextResponse.json({ ok: true, setup: buildConciergeSetupState(resolved.context, t) });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
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
              ? loadPersonalIdentityAtPath(safeIdentityPath) || {}
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
      const parsedBody = await readRequestObject(req, 'request body');
      if (!parsedBody.ok) throw new SetupInputError(parsedBody.error);
      body = parsedBody.body;
      const allowedKeys =
        body.action === 'save_management'
          ? ['action', 'tenant', 'agent', 'vision', 'name', 'primary_domain']
          : body.action === 'apply_onboarding'
            ? ['action', 'draft']
            : body.action === 'save_settings'
              ? ['action', 'patch']
              : body.action === 'avatar_generate'
                ? ['action', 'consent']
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
      // Never fall back to an implicit tenant: saving here must not create
      // `default` (or any other tenant) the operator did not choose.
      const activeSlug = (optionalSetupString(tenantInput, 'slug') || '').trim();
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
      const selectedTenant = activeSlug
        ? withExecutionContext('sovereign_concierge', () =>
            secureIo.withSensitivePathMediation(() => readTenantProfile(activeSlug))
          )
        : null;
      if (!selectedTenant) {
        return NextResponse.json(
          {
            ok: false,
            code: 'TENANT_SELECTION_REQUIRED',
            error: t('api.config.tenant_invalid'),
          },
          { status: 400 }
        );
      }
      const profileRoot = resolveActiveProfileRoot();
      const identityPath = path.join(profileRoot, 'my-identity.json');
      const visionPath = path.join(profileRoot, 'my-vision.md');
      const agentPath = path.join(profileRoot, 'agent-identity.json');
      const result = withExecutionContext('sovereign_concierge', () =>
        secureIo.withSensitivePathMediation(() => {
          const safeIdentityPath = resolveExistingProfileFile(identityPath);
          const currentIdentity = safeIdentityPath
            ? loadPersonalIdentityAtPath(safeIdentityPath) || {}
            : {};
          const currentTenant = selectedTenant;
          const safeAgentPath = resolveExistingProfileFile(agentPath);
          const currentAgent = safeAgentPath
            ? loadPersonalAgentIdentityAtPath(safeAgentPath) || {}
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
    if (body?.action === 'avatar_generate' || body?.action === 'avatar_use') {
      // PA-10: owner-only; the viewer (not the body) supplies the consenting principal.
      const viewer = resolveConciergeViewer(req);
      if (viewer.response) return viewer.response;
      // Loaded on demand so the other setup actions keep their light import graph.
      const { startAvatarGenerateAction, useGeneratedAvatarAction } =
        await import('./avatar-actions');
      return body.action === 'avatar_generate'
        ? startAvatarGenerateAction(body, viewer.context, t)
        : useGeneratedAvatarAction(viewer.context, t);
    }
    if (body?.action === 'save_settings') {
      // Settings sections send only edited fields; the writer merges them
      // onto the stored profile instead of re-submitting the onboarding draft.
      const patch = structuredClone(requireSetupObject(body.patch, 'patch')) as SetupInputObject;
      const voicePatch = optionalSetupObject(patch, 'voice');
      const patchSampleRefs = voicePatch
        ? optionalSetupStringArray(voicePatch, 'sample_refs')
        : undefined;
      if (voicePatch && patchSampleRefs) {
        voicePatch.sample_refs = patchSampleRefs.map((value) =>
          path.isAbsolute(value) ? value : pathResolver.rootResolve(value)
        );
      }
      try {
        const result = await secureIo.withSensitivePathMediation(() =>
          applyBrowserOnboardingSettingsPatch(patch)
        );
        return NextResponse.json({ ok: true, onboarding: result });
      } catch (error) {
        // A malformed patch is the caller's input, not a server fault.
        if (error instanceof Error && error.name === 'ZodError') {
          return NextResponse.json(
            { ok: false, error: t('api.onboarding_input') },
            { status: 400 }
          );
        }
        throw error;
      }
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
    return conciergeErrorResponse(error, 500);
  }
}
