import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import type { ImageGenerationProvider, ImageGenerationRequest } from './image-generation-types.js';

const mocks = vi.hoisted(() => ({
  executeServicePreset: vi.fn(),
  safeExecResult: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  safeReadFile: vi.fn(),
  probeToolRuntime: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('./service-engine.js', () => ({ executeServicePreset: mocks.executeServicePreset }));
vi.mock('./tool-runtime-registry.js', () => ({ probeToolRuntime: mocks.probeToolRuntime }));
vi.mock('./service-runtime-registry.js', () => ({ probeServiceRuntime: vi.fn() }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: mocks.auditRecord } }));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: vi.fn(),
}));
vi.mock('./secure-io.js', async () => {
  const actual = (await vi.importActual('./secure-io.js')) as Record<string, unknown>;
  return {
    ...actual,
    safeWriteFile: mocks.safeWriteFile,
    safeReadFile: mocks.safeReadFile,
    safeExecResult: mocks.safeExecResult,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
  };
});

import {
  AdaptivePolicyRouter,
  GeminiImageModelGenerationProvider,
  HostAgentImageGenerationProvider,
  LocalFluxImageGenerationProvider,
  buildGeminiImageContents,
  geminiContentImageBytes,
} from './image-generation-bridge.js';
import { createImageEgressConsent, validateImageEgressConsent } from './image-reference-consent.js';

const PHOTO = 'knowledge/personal/avatar.png';
const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

function stub(
  id: string,
  traits: Partial<ImageGenerationProvider> = {}
): ImageGenerationProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    id,
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue({ status: 'succeeded', provider: id, elapsedMs: 1 }),
    ...traits,
  } as ImageGenerationProvider & { generate: ReturnType<typeof vi.fn> };
}

function referenceRequest(extra: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'stylised portrait',
    referenceImages: [{ path: PHOTO, mimeType: 'image/png', role: 'subject' }],
    ...extra,
  };
}

const cloud = () =>
  stub('gemini_image', {
    supportsReferenceImages: true,
    dataEgress: 'cloud',
    executionLocality: 'remote',
  });
const local = () =>
  stub('local_flux', {
    supportsReferenceImages: true,
    dataEgress: 'local',
    executionLocality: 'local',
  });
const textOnly = () => stub('gemini_service', { executionLocality: 'remote' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeExistsSync.mockReturnValue(true);
  mocks.safeReadFile.mockReturnValue(Buffer.from('photo-bytes'));
});

describe('reference-image routing', () => {
  it('skips providers that cannot honour references, even when preferred', async () => {
    const router = new AdaptivePolicyRouter([textOnly(), local()]);
    const chain = await router.resolveCandidateChain(
      referenceRequest({ providerPreference: ['gemini_service', 'local_flux'] })
    );
    expect(chain.map((provider) => provider.id)).toEqual(['local_flux']);
  });

  it('keeps text-only providers for requests without references', async () => {
    const router = new AdaptivePolicyRouter([textOnly(), local()]);
    const chain = await router.resolveCandidateChain({
      prompt: 'x',
      providerPreference: ['gemini_service'],
    });
    expect(chain[0]?.id).toBe('gemini_service');
  });

  it('refuses a cloud provider for a reference request without consent', async () => {
    const provider = cloud();
    const router = new AdaptivePolicyRouter([provider]);
    const request = referenceRequest({ providerPreference: ['gemini_image'] });
    expect(await router.resolveCandidateChain(request)).toEqual([]);
    await expect(router.generateWithFallback(request)).rejects.toThrow(
      'IMAGE_REFERENCE_EGRESS_DENIED'
    );
    expect(provider.generate).not.toHaveBeenCalled();
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'image_generation.reference_egress',
        operation: 'gemini_image',
        result: 'denied',
      })
    );
  });

  it('allows the cloud provider named by a valid consent and records a receipt', async () => {
    const provider = cloud();
    const router = new AdaptivePolicyRouter([provider]);
    const consent = createImageEgressConsent({
      providerId: 'gemini_image',
      grantedBy: 'human:concierge-localadmin',
    });
    const request = referenceRequest({
      providerPreference: ['gemini_image'],
      egressConsent: consent,
    });
    const result = await router.generateWithFallback(request);
    expect(result.status).toBe('succeeded');
    expect(provider.generate).toHaveBeenCalledWith(request);
    const receipt = mocks.auditRecord.mock.calls[0]![0];
    expect(receipt).toMatchObject({
      action: 'image_generation.reference_egress',
      result: 'allowed',
      metadata: {
        provider_id: 'gemini_image',
        data_egress: 'cloud',
        reference_count: 1,
        consent_provider_id: 'gemini_image',
        consent_granted_by: 'human:concierge-localadmin',
      },
    });
    // The receipt never carries the personal-tier photo path.
    expect(JSON.stringify(receipt)).not.toContain('knowledge/personal');
  });

  it('refuses a consent that names a different provider', async () => {
    const router = new AdaptivePolicyRouter([cloud()]);
    const request = referenceRequest({
      egressConsent: createImageEgressConsent({ providerId: 'llm_api', grantedBy: 'me' }),
    });
    expect(await router.resolveCandidateChain(request)).toEqual([]);
  });

  it('allows a local provider without any consent', async () => {
    const provider = local();
    const router = new AdaptivePolicyRouter([cloud(), provider]);
    const result = await router.generateWithFallback(referenceRequest());
    expect(result.provider).toBe('local_flux');
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('plans the provider a consent prompt must name, without consent', async () => {
    const router = new AdaptivePolicyRouter([textOnly(), cloud()]);
    const planned = await router.planProvider(referenceRequest());
    expect(planned?.id).toBe('gemini_image');
  });
});

describe('validateImageEgressConsent', () => {
  const now = Date.parse('2026-09-24T10:00:00Z');
  const base = {
    subject: 'user_photo',
    provider_id: 'gemini_image',
    provider_class: 'cloud',
    granted_at: '2026-09-24T09:50:00Z',
    granted_by: 'human:owner',
  };
  it('accepts a fresh consent for the named provider', () => {
    expect(validateImageEgressConsent(base, 'gemini_image', { nowMs: now }).allowed).toBe(true);
  });
  it.each([
    ['missing', undefined],
    ['wrong subject', { ...base, subject: 'voice' }],
    ['wrong class', { ...base, provider_class: 'local' }],
    ['no granted_by', { ...base, granted_by: ' ' }],
    ['bad timestamp', { ...base, granted_at: 'yesterday' }],
    ['expired', { ...base, granted_at: '2026-09-24T07:00:00Z' }],
    ['future', { ...base, granted_at: '2026-09-24T12:00:00Z' }],
  ])('rejects %s', (_label, consent) => {
    expect(validateImageEgressConsent(consent, 'gemini_image', { nowMs: now }).allowed).toBe(false);
  });
});

describe('GeminiImageModelGenerationProvider', () => {
  it('sends inlineData parts plus the text prompt to generateContent', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      candidates: [
        { content: { parts: [{ text: 'here you go' }, { inlineData: { data: PNG_B64 } }] } },
      ],
    });
    const provider = new GeminiImageModelGenerationProvider();
    const result = await provider.generate(
      referenceRequest({
        targetPath: 'active/shared/tmp/avatar-test/neutral.png',
        aspectRatio: '1:1',
        egressConsent: createImageEgressConsent({ providerId: 'gemini_image', grantedBy: 'me' }),
      })
    );
    expect(result.status).toBe('succeeded');
    const [service, op, params, bindingKind] = mocks.executeServicePreset.mock.calls[0]!;
    expect([service, op, bindingKind]).toEqual([
      'gemini',
      'generate_content_image',
      'secret-guard',
    ]);
    expect(params.model).toBe('gemini-2.5-flash-image');
    expect(params.contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: Buffer.from('photo-bytes').toString('base64'),
            },
          },
          { text: 'stylised portrait' },
        ],
      },
    ]);
    expect(params.generation_config).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    });
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      'active/shared/tmp/avatar-test/neutral.png',
      Buffer.from('fake-png-bytes')
    );
  });

  it('refuses a direct reference call without consent before reading the photo', async () => {
    const provider = new GeminiImageModelGenerationProvider();
    await expect(provider.generate(referenceRequest())).rejects.toThrow(
      'IMAGE_REFERENCE_EGRESS_DENIED'
    );
    expect(mocks.safeReadFile).not.toHaveBeenCalled();
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('honours KYBERION_GEMINI_IMAGE_MODEL and rejects malformed ids', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      candidates: [{ content: { parts: [{ inline_data: { data: PNG_B64 } }] } }],
    });
    vi.stubEnv('KYBERION_GEMINI_IMAGE_MODEL', 'gemini-3-pro-image-preview');
    const provider = new GeminiImageModelGenerationProvider();
    await provider.generate({ prompt: 'text only', targetPath: 'active/shared/tmp/x.png' });
    expect(mocks.executeServicePreset.mock.calls[0]![2].model).toBe('gemini-3-pro-image-preview');
    vi.stubEnv('KYBERION_GEMINI_IMAGE_MODEL', '../../evil');
    const failed = await provider.generate({ prompt: 'x', targetPath: 'active/shared/tmp/x.png' });
    expect(failed.status).toBe('failed');
    vi.unstubAllEnvs();
  });

  it('rejects oversize references and unsupported mime types', () => {
    mocks.safeReadFile.mockReturnValue(Buffer.alloc(1024 * 1024 + 1));
    expect(() => buildGeminiImageContents(referenceRequest())).toThrow('too large');
    expect(() =>
      buildGeminiImageContents({
        prompt: 'x',
        referenceImages: [{ path: PHOTO, mimeType: 'image/svg+xml' }],
      })
    ).toThrow('mimeType not allowed');
  });

  it('extracts image bytes only from candidates[0] parts', () => {
    expect(geminiContentImageBytes({ candidates: [] })).toBeUndefined();
    expect(
      geminiContentImageBytes({ candidates: [{ content: { parts: [{ text: 'no image' }] } }] })
    ).toBeUndefined();
  });
});

describe('host bridge reference hand-off', () => {
  it('puts repo-relative reference paths in the request JSON and the message', async () => {
    vi.stubEnv('KYBERION_HOST_AGENT_ACTIVE', 'true');
    mocks.safeExistsSync.mockImplementation((target: string) => !target.endsWith('joy.png'));
    const provider = new HostAgentImageGenerationProvider();
    const consent = createImageEgressConsent({ providerId: 'host_agent', grantedBy: 'me' });
    const error = await provider
      .generate(
        referenceRequest({
          targetPath: 'active/shared/tmp/avatar-test/joy.png',
          referenceImages: [
            { path: PHOTO, mimeType: 'image/png', role: 'subject' },
            {
              path: 'knowledge/personal/avatar/neutral.png',
              mimeType: 'image/png',
              role: 'consistency',
            },
          ],
          egressConsent: consent,
        })
      )
      .catch((caught: Error) => caught);
    expect(String(error)).toContain('HOST_AGENT_IMAGE_GENERATION_REQUIRED');
    expect(String(error)).toContain(`"${PHOTO}" (subject)`);
    expect(String(error)).toContain('"knowledge/personal/avatar/neutral.png" (consistency)');
    const [requestPath, body] = mocks.safeWriteFile.mock.calls[0]!;
    expect(requestPath).toBe(
      pathResolver.resolve('active/shared/tmp/host_agent_image_request.json')
    );
    const payload = JSON.parse(String(body));
    expect(payload.referenceImages).toEqual([
      { path: PHOTO, mimeType: 'image/png', role: 'subject' },
      { path: 'knowledge/personal/avatar/neutral.png', mimeType: 'image/png', role: 'consistency' },
    ]);
    expect(payload.egressConsent).toEqual({
      provider_id: 'host_agent',
      granted_at: consent.granted_at,
    });
    vi.unstubAllEnvs();
  });

  it('refuses a reference hand-off without consent (host agent is cloud egress)', async () => {
    mocks.safeExistsSync.mockReturnValue(false);
    const provider = new HostAgentImageGenerationProvider();
    await expect(
      provider.generate(referenceRequest({ targetPath: 'active/shared/tmp/avatar-test/a.png' }))
    ).rejects.toThrow('IMAGE_REFERENCE_EGRESS_DENIED');
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });
});

describe('mflux img2img', () => {
  it('passes the consistency reference as --image-path', async () => {
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'use',
      selected_backend: { command: 'mflux-generate', args: [] },
    });
    mocks.safeExecResult.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const provider = new LocalFluxImageGenerationProvider();
    await provider.generate(
      referenceRequest({
        targetPath: 'active/shared/tmp/avatar-test/joy.png',
        referenceImages: [
          { path: PHOTO, mimeType: 'image/png', role: 'subject' },
          {
            path: 'knowledge/personal/avatar/neutral.png',
            mimeType: 'image/png',
            role: 'consistency',
          },
        ],
      })
    );
    const args = mocks.safeExecResult.mock.calls[0]![1] as string[];
    const index = args.indexOf('--image-path');
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe(pathResolver.resolve('knowledge/personal/avatar/neutral.png'));
  });
});
