import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';

const PROFILE_ROOT = pathResolver.sharedTmp('browser-onboarding-tests/profile');
const PORTABLE_EMAIL_BACKEND = process.platform === 'darwin' ? 'mac_mailapp' : 'smtp';

const { resolveActiveProfileRootMock } = vi.hoisted(() => ({
  resolveActiveProfileRootMock: vi.fn(),
}));

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: resolveActiveProfileRootMock,
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
  resolveActiveProfileRootMock.mockReset();
  resolveActiveProfileRootMock.mockReturnValue(PROFILE_ROOT);
  if (PORTABLE_EMAIL_BACKEND === 'smtp') {
    vi.stubEnv('KYBERION_SMTP_HOST', 'smtp.test.invalid');
    vi.stubEnv('KYBERION_SMTP_USER', 'test-user');
    vi.stubEnv('KYBERION_SMTP_PASS', 'test-pass');
  }
});

afterEach(() => {
  safeRmSync(pathResolver.sharedTmp('browser-onboarding-tests'), { recursive: true, force: true });
  vi.unstubAllEnvs();
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

  it('rejects unknown fields at every onboarding request boundary', async () => {
    const { previewBrowserOnboarding } = await import('./browser-onboarding.js');

    expect(() => previewBrowserOnboarding({ ...validDraft(), unexpected: true })).toThrow(
      /Unrecognized key/
    );
    expect(() =>
      previewBrowserOnboarding({
        ...validDraft(),
        providers: { ...validDraft().providers, unexpected: true },
      })
    ).toThrow(/Unrecognized key/);
    expect(() =>
      previewBrowserOnboarding({
        ...validDraft(),
        tools: {
          ...validDraft().tools,
          mode_preference: { ...validDraft().tools.mode_preference, unexpected: true },
        },
      })
    ).toThrow(/Unrecognized key/);
  });

  it('rejects a symlinked active profile root before reading onboarding state', async () => {
    const targetRoot = pathResolver.sharedTmp('browser-onboarding-tests/redirect-target');
    const linkedRoot = pathResolver.sharedTmp('browser-onboarding-tests/profile-link');
    safeMkdir(targetRoot, { recursive: true });
    safeSymlinkSync(targetRoot, linkedRoot);
    resolveActiveProfileRootMock.mockReturnValue(linkedRoot);

    const { previewBrowserOnboarding } = await import('./browser-onboarding.js');

    expect(() => previewBrowserOnboarding(validDraft())).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('rejects a directory replacing the optional vision resource', async () => {
    safeMkdir(path.join(PROFILE_ROOT, 'my-vision.md'), { recursive: true });

    const { getBrowserOnboardingState } = await import('./browser-onboarding.js');

    expect(() => getBrowserOnboardingState()).toThrow(
      /\[BROWSER_ONBOARDING_RESOURCE\] vision must be a regular file/
    );
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
        String(safeReadFile(path.join(PROFILE_ROOT, 'my-identity.json'), { encoding: 'utf8' }))
      )
    ).toMatchObject({
      name: 'Browser Operator',
      vision: 'Configure Kyberion safely from a browser.',
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
        'email.backend': PORTABLE_EMAIL_BACKEND,
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
    vi.stubEnv('KYBERION_PERSONA', 'worker');
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

  it('rejects an invalid existing voice registry before onboarding overwrites it', async () => {
    const voiceDir = path.join(PROFILE_ROOT, 'voice');
    safeMkdir(voiceDir, { recursive: true });
    safeWriteFile(path.join(voiceDir, 'profile-registry.json'), JSON.stringify({ profiles: [] }));
    const samplePath = path.join(PROFILE_ROOT, 'voice', 'samples', 'my-voice', 'sample.webm');
    safeMkdir(path.dirname(samplePath), { recursive: true });
    safeWriteFile(samplePath, 'voice sample');

    const { applyBrowserOnboarding } = await import('./browser-onboarding.js');
    await expect(
      applyBrowserOnboarding({
        ...validDraft(),
        voice: {
          enabled: true,
          profile_id: 'my-voice',
          display_name: 'My Voice',
          language: 'ja',
          engine_id: 'mlx_audio_qwen3',
          sample_refs: [samplePath],
        },
      })
    ).rejects.toThrow(/Invalid catalog voice-profile-registry/);
  });

  it('rejects a symlinked voice sample profile before writing the sample', async () => {
    const targetDir = pathResolver.sharedTmp('browser-onboarding-tests/voice-target');
    const linkedDir = path.join(PROFILE_ROOT, 'voice', 'samples', 'my-voice');
    safeMkdir(targetDir, { recursive: true });
    safeMkdir(path.dirname(linkedDir), { recursive: true });
    safeSymlinkSync(targetDir, linkedDir);

    const { saveBrowserOnboardingVoiceSample } = await import('./browser-onboarding.js');
    expect(() =>
      saveBrowserOnboardingVoiceSample({
        profileId: 'my-voice',
        contentType: 'audio/webm',
        data: Buffer.from('voice sample'),
      })
    ).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(safeExistsSync(path.join(targetDir, 'sample.webm'))).toBe(false);
  });

  it('keeps personal onboarding writes inside the sovereign concierge context', async () => {
    const { applyBrowserOnboarding } = await import('./browser-onboarding.js');
    vi.stubEnv('KYBERION_PERSONA', 'worker');
    const result = await applyBrowserOnboarding(validDraft());
    expect(result.ok).toBe(true);
    expect(safeExistsSync(path.join(PROFILE_ROOT, 'my-identity.json'))).toBe(true);
  });

  it('preserves existing identity metadata while updating onboarding fields', async () => {
    const { applyBrowserOnboarding } = await import('./browser-onboarding.js');
    safeMkdir(PROFILE_ROOT, { recursive: true });
    safeWriteFile(
      path.join(PROFILE_ROOT, 'my-identity.json'),
      JSON.stringify({ name: 'Existing', avatar_path: 'avatar.png', custom_preference: 'quiet' })
    );

    await applyBrowserOnboarding(validDraft());

    expect(
      JSON.parse(
        String(safeReadFile(path.join(PROFILE_ROOT, 'my-identity.json'), { encoding: 'utf8' }))
      )
    ).toMatchObject({
      avatar_path: 'avatar.png',
      custom_preference: 'quiet',
      vision: 'Configure Kyberion safely from a browser.',
    });
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
