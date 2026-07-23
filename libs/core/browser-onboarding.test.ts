import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

const PROFILE_ROOT = pathResolver.sharedTmp('browser-onboarding-tests/profile');

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => PROFILE_ROOT,
}));

const validDraft = () => ({
  version: '1.0.0' as const,
  identity: {
    name: 'Browser Operator',
    language: 'ja',
    interaction_style: 'Senior Partner' as const,
    primary_domain: 'Kyberion operations',
    vision: 'Configure Kyberion safely from a browser.',
    agent_id: 'KYBERION-BROWSER',
  },
  voice: {
    enabled: false,
    language: 'ja',
    engine_id: 'mlx_audio_qwen3',
    sample_refs: [],
  },
  services: [{ service_id: 'github' as const, auth_mode: 'oauth' as const, required: true }],
  providers: {
    priority: ['codex', 'claude', 'gemini'],
    default_models: { codex: 'gpt-5.5' },
  },
  tools: {
    mode_preference: {
      python: 'trial_first' as const,
      node: 'installed_first' as const,
      system: 'installed_only' as const,
    },
    install_requires_approval: true,
    pin_requires_approval: true,
  },
  tutorial: { mode: 'simulate' as const, summary: 'Run a safe tutorial.' },
});

beforeEach(() => {
  safeRmSync(pathResolver.sharedTmp('browser-onboarding-tests'), { recursive: true, force: true });
});

afterEach(() => {
  safeRmSync(pathResolver.sharedTmp('browser-onboarding-tests'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('browser onboarding', () => {
  it('previews governed effects without writing profile artifacts', async () => {
    const { previewBrowserOnboarding } = await import('./browser-onboarding.js');
    const preview = previewBrowserOnboarding(validDraft());

    expect(preview.ok).toBe(true);
    expect(preview.effects.some((effect) => effect.kind === 'providers')).toBe(true);
    expect(preview.effects.some((effect) => effect.kind === 'service')).toBe(true);
    expect(safeExistsSync(PROFILE_ROOT)).toBe(false);
  });

  it('applies identity, provider, tool, service, and receipt artifacts under the active profile', async () => {
    const { applyBrowserOnboarding, loadOperatorProviderPreferences } =
      await import('./browser-onboarding.js');
    const result = await applyBrowserOnboarding(validDraft());

    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(7);
    expect(
      result.artifacts.every((artifact) =>
        path.resolve(artifact).startsWith(path.resolve(PROFILE_ROOT))
      )
    ).toBe(true);
    expect(loadOperatorProviderPreferences()).toEqual({
      priority: ['codex', 'claude', 'gemini'],
      default_models: { codex: 'gpt-5.5' },
    });
    expect(
      JSON.parse(
        String(
          safeReadFile(path.join(PROFILE_ROOT, 'connections/github.json'), { encoding: 'utf8' })
        )
      )
    ).toMatchObject({
      service_id: 'github',
      status: 'proposed',
      credential_ref: null,
    });
  });

  it('persists the selected reasoning provider and routes the default role through it', async () => {
    const { applyBrowserOnboarding } = await import('./browser-onboarding.js');
    const result = await applyBrowserOnboarding({
      ...validDraft(),
      reasoning: { provider: 'stub' },
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts).toContain(path.join(PROFILE_ROOT, 'onboarding', 'llm-selection.json'));
    expect(
      JSON.parse(
        String(
          safeReadFile(path.join(PROFILE_ROOT, 'onboarding', 'llm-selection.json'), {
            encoding: 'utf8',
          })
        )
      )
    ).toMatchObject({ provider: 'stub', version: '1.0.0' });

    const { resolveReasoningRoute } = await import('./reasoning-route-resolver.js');
    expect(resolveReasoningRoute({ role: 'default', env: {} }).mode).toBe('stub');
  });

  it('persists adapter-backed runtime defaults and rejects unknown candidates', async () => {
    const { applyBrowserOnboarding, previewBrowserOnboarding } =
      await import('./browser-onboarding.js');
    const result = await applyBrowserOnboarding({
      ...validDraft(),
      adapter_defaults: {
        'media.image': 'media-generation.comfyui',
        'media.video': 'video.hyperframes_cli',
        'media.music': 'media-generation.comfyui.music',
        'service.runtime': 'comfyui',
        'tool.runtime': 'playwright',
        'voice.vad': 'energy',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts).toContain(
      path.join(PROFILE_ROOT, 'onboarding', 'adapter-defaults.json')
    );
    expect(
      JSON.parse(
        String(
          safeReadFile(path.join(PROFILE_ROOT, 'onboarding', 'adapter-defaults.json'), {
            encoding: 'utf8',
          })
        )
      )
    ).toMatchObject({
      defaults: {
        'media.image': 'media-generation.comfyui',
        'service.runtime': 'comfyui',
        'voice.vad': 'energy',
      },
    });

    expect(() =>
      previewBrowserOnboarding({
        ...validDraft(),
        adapter_defaults: { 'media.image': 'not-registered' },
      })
    ).toThrow(/Unknown adapter default candidate/);
  });

  it('rejects an unregistered reasoning provider before writing onboarding artifacts', async () => {
    const { previewBrowserOnboarding } = await import('./browser-onboarding.js');

    expect(() =>
      previewBrowserOnboarding({
        ...validDraft(),
        reasoning: { provider: 'not-registered' },
      })
    ).toThrow(/Unknown reasoning provider/);
    expect(safeExistsSync(PROFILE_ROOT)).toBe(false);
  });

  it('stores supported voice samples only inside the active profile', async () => {
    const { saveBrowserOnboardingVoiceSample } = await import('./browser-onboarding.js');
    const sample = saveBrowserOnboardingVoiceSample({
      profileId: 'my-voice',
      contentType: 'audio/webm;codecs=opus',
      data: Buffer.from('voice sample'),
    });

    expect(sample.sample_ref).toContain('/voice/samples/my-voice/');
    expect(safeExistsSync(sample.sample_ref)).toBe(true);
    expect(() =>
      saveBrowserOnboardingVoiceSample({
        profileId: 'my-voice',
        contentType: 'application/octet-stream',
        data: Buffer.from('bad'),
      })
    ).toThrow(/unsupported voice sample content type/);
  });

  it('rejects duplicate providers, duplicate services, and unknown services', async () => {
    const { previewBrowserOnboarding } = await import('./browser-onboarding.js');
    const duplicateProvider = validDraft();
    duplicateProvider.providers.priority = ['codex', 'codex'];
    expect(() => previewBrowserOnboarding(duplicateProvider)).toThrow(
      /provider priority contains duplicates/
    );

    const duplicateService = validDraft();
    duplicateService.services.push({ service_id: 'github', auth_mode: 'oauth', required: false });
    expect(() => previewBrowserOnboarding(duplicateService)).toThrow(/services contain duplicates/);

    expect(() =>
      previewBrowserOnboarding({
        ...validDraft(),
        services: [{ service_id: 'unknown-service', auth_mode: 'oauth', required: false }],
      })
    ).toThrow();
  });
});
