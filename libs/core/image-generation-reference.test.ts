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
  GEMINI_REFERENCE_MAX_EDGE_PX,
  buildGeminiImageContents,
  prepareGeminiReferenceImage,
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

  it('downscales realistic photos and 1024px frames under the inline budget (M1)', async () => {
    const { Jimp } = await import('jimp');
    // A noisy 3000x2000 JPEG (a phone photo of several MB) and a noisy 1024² PNG frame.
    // Photo-like content: a smooth gradient with sensor-like noise (defeats PNG compression).
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const noisy = (width: number, height: number, amplitude = 24) => {
      const data = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const base = ((x / width) * 160 + (y / height) * 80) | 0;
          for (let c = 0; c < 3; c += 1) {
            data[offset + c] = Math.max(
              0,
              Math.min(255, base + c * 20 + (rand() - 0.5) * amplitude)
            );
          }
          data[offset + 3] = 255;
        }
      }
      return new Jimp({ data, width, height });
    };
    const photo = Buffer.from(await noisy(3000, 2000).getBuffer('image/jpeg', { quality: 95 }));
    const frame = Buffer.from(await noisy(1024, 1024).getBuffer('image/png'));
    expect(photo.length).toBeGreaterThan(1024 * 1024);
    expect(frame.length).toBeGreaterThan(1024 * 1024);
    mocks.safeReadFile.mockImplementation((target: string) =>
      target.endsWith('neutral.png') ? frame : photo
    );
    const contents = await buildGeminiImageContents({
      prompt: 'stylised portrait',
      referenceImages: [
        { path: PHOTO, mimeType: 'image/jpeg', role: 'subject' },
        { path: 'knowledge/personal/avatar/draft/neutral.png', mimeType: 'image/png' },
      ],
    });
    const inline = contents[0]!.parts.slice(0, 2) as Array<{
      inlineData: { mimeType: string; data: string };
    }>;
    let total = 0;
    for (const part of inline) {
      expect(part.inlineData.mimeType).toBe('image/jpeg');
      const bytes = Buffer.from(part.inlineData.data, 'base64');
      total += bytes.length;
      const decoded = await Jimp.read(bytes);
      expect(Math.max(decoded.bitmap.width, decoded.bitmap.height)).toBe(
        GEMINI_REFERENCE_MAX_EDGE_PX
      );
    }
    expect(total).toBeLessThan(1400 * 1024);
  }, 30_000);

  it('steps a very detailed reference down until it fits its budget share', async () => {
    const { Jimp } = await import('jimp');
    const data = Buffer.alloc(1024 * 1024 * 4);
    let seed = 7;
    for (let i = 0; i < data.length; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      data[i] = i % 4 === 3 ? 255 : seed >>> 24;
    }
    const noise = Buffer.from(
      await new Jimp({ data, width: 1024, height: 1024 }).getBuffer('image/png')
    );
    const prepared = await prepareGeminiReferenceImage(noise, 'image/png', 700 * 1024);
    expect(prepared.mimeType).toBe('image/jpeg');
    expect(prepared.bytes.length).toBeLessThanOrEqual(700 * 1024);
  }, 30_000);

  it('rejects undecodable oversize references and unsupported mime types', async () => {
    mocks.safeReadFile.mockReturnValue(Buffer.alloc(1024 * 1024 + 1));
    await expect(buildGeminiImageContents(referenceRequest())).rejects.toThrow('too large');
    mocks.safeReadFile.mockReturnValue(Buffer.alloc(17 * 1024 * 1024));
    await expect(buildGeminiImageContents(referenceRequest())).rejects.toThrow('too large');
    await expect(
      buildGeminiImageContents({
        prompt: 'x',
        referenceImages: [{ path: PHOTO, mimeType: 'image/svg+xml' }],
      })
    ).rejects.toThrow('mimeType not allowed');
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

  it('records a second receipt when the rerun picks up the host-produced frame (m1)', async () => {
    mocks.safeExistsSync.mockReturnValue(true);
    const provider = new HostAgentImageGenerationProvider();
    const consent = createImageEgressConsent({ providerId: 'host_agent', grantedBy: 'me' });
    const result = await provider.generate(
      referenceRequest({
        targetPath: 'active/shared/tmp/avatar-test/joy.png',
        egressConsent: consent,
      })
    );
    expect(result.status).toBe('succeeded');
    expect(mocks.auditRecord).toHaveBeenCalledTimes(1);
    const receipt = mocks.auditRecord.mock.calls[0]![0];
    expect(receipt).toMatchObject({
      action: 'image_generation.reference_egress',
      result: 'allowed',
      metadata: {
        provider_id: 'host_agent',
        stage: 'host_output_collected',
        reference_count: 1,
        consent_provider_id: 'host_agent',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(PHOTO);
    // A plain generation (no references) leaves no receipt.
    mocks.auditRecord.mockClear();
    await provider.generate({ prompt: 'x', targetPath: 'active/shared/tmp/avatar-test/joy.png' });
    expect(mocks.auditRecord).not.toHaveBeenCalled();
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
