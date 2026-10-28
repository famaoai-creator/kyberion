import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import path from 'node:path';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
const { appleGate, applePrompt } = vi.hoisted(() => ({ appleGate: vi.fn(), applePrompt: vi.fn() }));
vi.mock('../apple-intelligence-bridge.js', () => ({
  gateAppleLane: appleGate,
  appleFmPromptWithImage: applePrompt,
}));
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../windows-native-image-recognition-bridge.js', () => ({
  probeWindowsNativeImageRecognition: probe,
  describeImageWithWindowsNativeApi: vi.fn(() => ''),
}));
vi.mock('../network.js', () => ({ secureFetch: fetchMock }));

import {
  AppleNativeImageDescriptionProvider,
  createExperimentalAppleImageDescribeFn,
  ImageDescriptionUnavailableError,
  OllamaVisionImageDescriptionProvider,
  ReasoningVisionImageDescriptionProvider,
  createReasoningVisionDescribeFn,
  describeImage,
  inferImagePayloadTier,
} from './image-description-bridge.js';
import {
  getReasoningPayloadScope,
  type ReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';
import type {
  ReasoningBackend,
  ReasoningImageAttachment,
} from '../reasoning/reasoning-backend-contracts.js';
import { pathResolver } from '../path-resolver.js';

interface VisionCall {
  prompt: string;
  images: ReasoningImageAttachment[];
  scope: ReasoningPayloadScope | undefined;
}

function textOnlyBackend(): ReasoningBackend {
  return {
    name: 'text-cli',
    prompt: async () => 'text reply',
    delegateTask: async () => 'delegated',
  } as unknown as ReasoningBackend;
}

function visionBackend(
  calls: VisionCall[],
  reply = 'A login form with two fields.'
): ReasoningBackend {
  return {
    ...textOnlyBackend(),
    name: 'vision-fake',
    promptWithImages: async (prompt: string, images: ReasoningImageAttachment[]) => {
      calls.push({ prompt, images, scope: getReasoningPayloadScope() });
      return `  ${reply}\n`;
    },
  } as unknown as ReasoningBackend;
}

const fixtureRoot = pathResolver.rootResolve(
  'active/shared/tmp/public/shared/image-description-tests/' + process.pid
);
const fixture = (name: string) => path.join(fixtureRoot, name);
afterEach(() => {
  vi.unstubAllEnvs();
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of [
    'screens/shot.png',
    'confidential/MSN-X/evidence/shot.jpg',
    'shot.png',
    'shot.bmp',
    'redaction/redacted.png',
    'tile.png',
  ]) {
    safeMkdir(path.dirname(fixture(name)), { recursive: true });
    safeWriteFile(fixture(name), Buffer.from('fixture image bytes'));
  }
  appleGate.mockReset().mockResolvedValue({ available: false, reason: 'test platform' });
  applePrompt.mockReset();
  probe.mockReturnValue({ ocr: false, description: false, reason: 'requires Windows' });
  fetchMock.mockReset();
});

describe('describeImage with the reasoning_vision provider', () => {
  it('describes through the vision channel when no native describer exists', async () => {
    const calls: VisionCall[] = [];
    const result = await describeImage(
      { path: fixture('screens/shot.png'), kind: 'accessible' },
      { resolveBackend: () => visionBackend(calls) }
    );

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('reasoning_vision');
    expect(result.description).toBe('A login form with two fields.');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toMatch(/alt text/);
    expect(calls[0].images).toEqual([
      {
        path: pathResolver.rootResolve(fixture('screens/shot.png')),
        media_type: 'image/png',
      },
    ]);
    expect(calls[0].scope).toMatchObject({
      tier: 'public',
      purpose: 'image description',
      attachment_count: 1,
    });
  });

  it('raises a declared tier to the tier implied by the image path, never lowers it', async () => {
    const calls: VisionCall[] = [];
    await describeImage(
      { path: fixture('confidential/MSN-X/evidence/shot.jpg') },
      { tier: 'public', tenant_slug: 'acme', resolveBackend: () => visionBackend(calls) }
    );
    expect(calls[0].images[0].media_type).toBe('image/jpeg');
    expect(calls[0].scope).toMatchObject({ tier: 'confidential', tenant_slug: 'acme' });

    await describeImage(
      { path: fixture('shot.png') },
      { tier: 'personal', resolveBackend: () => visionBackend(calls) }
    );
    expect(calls[1].scope?.tier).toBe('personal');
  });

  it('fails explicitly with a typed error when the backend is text-only', async () => {
    const error = await describeImage(
      { path: fixture('shot.png') },
      { resolveBackend: () => textOnlyBackend() }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageDescriptionUnavailableError);
    expect((error as ImageDescriptionUnavailableError).code).toBe('NO_IMAGE_DESCRIPTION_PROVIDER');
  });

  it('treats an explicit supportsVision=false as text-only', async () => {
    const calls: VisionCall[] = [];
    const backend = { ...visionBackend(calls), supportsVision: false } as ReasoningBackend;
    await expect(
      new ReasoningVisionImageDescriptionProvider({ resolveBackend: () => backend }).isAvailable()
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports a failed result when the vision call errors', async () => {
    const backend = {
      ...textOnlyBackend(),
      promptWithImages: async () => {
        throw new Error('vision api down');
      },
    } as unknown as ReasoningBackend;
    const result = await describeImage(
      { path: fixture('shot.png') },
      { resolveBackend: () => backend }
    );
    expect(result).toMatchObject({ status: 'failed', provider: 'reasoning_vision' });
    expect(result.error).toMatch(/vision api down/);
  });

  it('refuses media types the vision channel cannot carry', async () => {
    const calls: VisionCall[] = [];
    const result = await describeImage(
      { path: fixture('shot.bmp') },
      { resolveBackend: () => visionBackend(calls) }
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/VISION_UNSUPPORTED_MEDIA_TYPE/);
    expect(calls).toHaveLength(0);
  });
});

describe('OllamaVisionImageDescriptionProvider', () => {
  it('refuses non-loopback endpoints', async () => {
    const provider = new OllamaVisionImageDescriptionProvider('https://example.invalid', 'vision');
    await expect(provider.isAvailable()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('prepare_egress_image', () => {
  it('sends only the prepared copy, keeps the original tier and disposes the copy', async () => {
    const calls: VisionCall[] = [];
    const dispose = vi.fn();
    const prepared = pathResolver.rootResolve(fixture('redaction/redacted.png'));
    const prepare = vi.fn(async () => ({ path: prepared, dispose }));
    const result = await describeImage(
      { path: fixture('confidential/MSN-X/evidence/shot.jpg') },
      {
        tenant_slug: 'acme',
        prepare_egress_image: prepare,
        resolveBackend: () => visionBackend(calls),
      }
    );
    expect(result.status).toBe('succeeded');
    expect(prepare).toHaveBeenCalledWith(
      pathResolver.rootResolve(fixture('confidential/MSN-X/evidence/shot.jpg'))
    );
    expect(calls[0].images).toEqual([{ path: prepared, media_type: 'image/png' }]);
    expect(calls[0].scope).toMatchObject({ tier: 'confidential', tenant_slug: 'acme' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when preparation fails', async () => {
    const calls: VisionCall[] = [];
    const result = await describeImage(
      { path: fixture('shot.png') },
      {
        prepare_egress_image: async () => {
          throw new Error('screen frame withheld: ocr_unavailable');
        },
        resolveBackend: () => visionBackend(calls),
      }
    );
    expect(result).toMatchObject({ status: 'failed', provider: 'reasoning_vision' });
    expect(result.error).toMatch(/withheld/);
    expect(calls).toHaveLength(0);
  });
});

describe('createReasoningVisionDescribeFn', () => {
  it('returns the trimmed description and honours a custom prompt', async () => {
    const calls: VisionCall[] = [];
    const describeFn = createReasoningVisionDescribeFn({
      resolveBackend: () => visionBackend(calls, 'Tile shows a toolbar.'),
    });
    await expect(
      describeFn({ path: fixture('tile.png'), prompt: 'Describe this tile.' })
    ).resolves.toBe('Tile shows a toolbar.');
    expect(calls[0].prompt).toBe('Describe this tile.');
  });

  it('throws VISION_BACKEND_TEXT_ONLY for a text-only backend', async () => {
    const describeFn = createReasoningVisionDescribeFn({ resolveBackend: () => textOnlyBackend() });
    const error = await describeFn({ path: fixture('tile.png') }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ImageDescriptionUnavailableError);
    expect((error as ImageDescriptionUnavailableError).code).toBe('VISION_BACKEND_TEXT_ONLY');
  });
});

describe('inferImagePayloadTier', () => {
  it('reads the tier from the path', () => {
    expect(inferImagePayloadTier(pathResolver.rootResolve('active/shared/tmp/a.png'))).toBe(
      'public'
    );
    expect(
      inferImagePayloadTier(pathResolver.rootResolve('active/missions/confidential/M/a.png'))
    ).toBe('confidential');
    expect(inferImagePayloadTier(pathResolver.rootResolve('knowledge/personal/a.png'))).toBe(
      'personal'
    );
  });
});

const SAMPLE_IMAGE = 'docs/assets/kyberion-social-preview.png';
describe('Apple native image description integration', () => {
  it('uses Apple only when explicitly selected', async () => {
    appleGate.mockResolvedValue({ available: true });
    applePrompt.mockResolvedValue('  Local image description.  ');
    const resolveBackend = vi.fn(() => textOnlyBackend());
    const result = await describeImage(
      { path: SAMPLE_IMAGE, kind: 'accessible' },
      { providers: [new AppleNativeImageDescriptionProvider()], resolveBackend }
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      provider: 'apple_native',
      description: 'Local image description.',
    });
    expect(applePrompt).toHaveBeenCalledWith(
      expect.stringContaining('alt text'),
      pathResolver.rootResolve(SAMPLE_IMAGE)
    );
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('keeps the configured default and payload tier even when Apple is available', async () => {
    appleGate.mockResolvedValue({ available: true });
    applePrompt.mockResolvedValue(null);
    const calls: VisionCall[] = [];
    const result = await describeImage(
      { path: SAMPLE_IMAGE },
      { tier: 'confidential', tenant_slug: 'acme', resolveBackend: () => visionBackend(calls) }
    );
    expect(result.provider).toBe('reasoning_vision');
    expect(calls[0].scope).toMatchObject({ tier: 'confidential', tenant_slug: 'acme' });
    expect(appleGate).not.toHaveBeenCalled();
    expect(applePrompt).not.toHaveBeenCalled();
  });

  it('honours an explicit local Ollama configuration ahead of Apple', async () => {
    vi.stubEnv('OLLAMA_VLM_MODEL', 'vision-test');
    appleGate.mockResolvedValue({ available: true });
    fetchMock.mockImplementation(async (request) =>
      request.method === 'GET'
        ? { models: [{ name: 'vision-test' }] }
        : { response: 'Ollama description.' }
    );
    const result = await describeImage(
      { path: SAMPLE_IMAGE },
      { resolveBackend: () => textOnlyBackend() }
    );
    expect(result.provider).toBe('ollama_vision');
    expect(appleGate).not.toHaveBeenCalled();
    expect(applePrompt).not.toHaveBeenCalled();
  });

  it('keeps an explicit provider failure terminal', async () => {
    appleGate.mockResolvedValue({ available: true });
    applePrompt.mockResolvedValue(null);
    const resolveBackend = vi.fn(() => textOnlyBackend());
    const result = await describeImage(
      { path: SAMPLE_IMAGE },
      { providers: [new AppleNativeImageDescriptionProvider()], resolveBackend }
    );
    expect(result).toMatchObject({ status: 'failed', provider: 'apple_native' });
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('never calls native or cloud for a denied path', async () => {
    appleGate.mockResolvedValue({ available: true });
    const resolveBackend = vi.fn(() => textOnlyBackend());
    await expect(describeImage({ path: '/etc/passwd' }, { resolveBackend })).rejects.toThrow();
    expect(applePrompt).not.toHaveBeenCalled();
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('stops before native and fallback when image preparation is denied', async () => {
    appleGate.mockResolvedValue({ available: true });
    const resolveBackend = vi.fn(() => textOnlyBackend());
    await expect(
      describeImage(
        { path: SAMPLE_IMAGE },
        {
          providers: [
            new AppleNativeImageDescriptionProvider({
              prepare_egress_image: async () => {
                throw new Error('screen frame withheld');
              },
            }),
          ],
          resolveBackend,
        }
      )
    ).rejects.toThrow('screen frame withheld');
    expect(applePrompt).not.toHaveBeenCalled();
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('passes only the prepared image to Apple while retaining the original tier and disposing it', async () => {
    appleGate.mockResolvedValue({ available: true });
    const preparedPath = pathResolver.rootResolve('docs/assets/pads/daily-desk.png');
    const dispose = vi.fn();
    let scope: ReasoningPayloadScope | undefined;
    applePrompt.mockImplementation(async () => {
      scope = getReasoningPayloadScope();
      return 'redacted scene';
    });
    const result = await describeImage(
      { path: SAMPLE_IMAGE },
      {
        providers: [
          new AppleNativeImageDescriptionProvider({
            tier: 'personal',
            prepare_egress_image: async () => ({ path: preparedPath, dispose }),
          }),
        ],
      }
    );
    expect(result.provider).toBe('apple_native');
    expect(applePrompt).toHaveBeenCalledWith(expect.any(String), preparedPath);
    expect(scope).toMatchObject({ tier: 'personal' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('experimental DescribeFn preserves custom tile prompts and skips cloud on success', async () => {
    appleGate.mockResolvedValue({ available: true });
    applePrompt.mockResolvedValue('Tile with toolbar.');
    const resolveBackend = vi.fn(() => textOnlyBackend());
    const describe = createExperimentalAppleImageDescribeFn({ resolveBackend });
    await expect(
      describe({ path: SAMPLE_IMAGE, prompt: 'Describe this precise tile.' })
    ).resolves.toBe('Tile with toolbar.');
    expect(applePrompt).toHaveBeenCalledWith(
      'Describe this precise tile.',
      pathResolver.rootResolve(SAMPLE_IMAGE)
    );
    expect(resolveBackend).not.toHaveBeenCalled();
  });

  it('experimental DescribeFn retains the existing reasoning fallback and its custom prompt', async () => {
    appleGate.mockResolvedValue({ available: true });
    applePrompt.mockResolvedValue(null);
    const calls: VisionCall[] = [];
    const describe = createExperimentalAppleImageDescribeFn({
      tier: 'confidential',
      tenant_slug: 'acme',
      resolveBackend: () => visionBackend(calls),
    });
    await describe({ path: SAMPLE_IMAGE, prompt: 'Describe this precise tile.' });
    expect(calls[0].prompt).toBe('Describe this precise tile.');
    expect(calls[0].scope).toMatchObject({ tier: 'confidential', tenant_slug: 'acme' });
  });
});

describe('experimental Apple source authorization', () => {
  it('blocks denied input before preparation even when Apple is unavailable', async () => {
    const prepare = vi.fn();
    const resolveBackend = vi.fn(() => textOnlyBackend());
    const describe = createExperimentalAppleImageDescribeFn({
      prepare_egress_image: prepare,
      resolveBackend,
    });
    await expect(describe({ path: '/etc/passwd' })).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(appleGate).not.toHaveBeenCalled();
    expect(applePrompt).not.toHaveBeenCalled();
    expect(resolveBackend).not.toHaveBeenCalled();
  });
});

describe('default image description source authorization', () => {
  it('blocks denied input before preparation or any backend even when Apple is unavailable', async () => {
    const prepare = vi.fn();
    const resolveBackend = vi.fn(() => textOnlyBackend());
    await expect(
      describeImage({ path: '/etc/passwd' }, { prepare_egress_image: prepare, resolveBackend })
    ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(appleGate).not.toHaveBeenCalled();
    expect(applePrompt).not.toHaveBeenCalled();
    expect(resolveBackend).not.toHaveBeenCalled();
  });
});
