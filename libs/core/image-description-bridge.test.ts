import { beforeEach, describe, expect, it, vi } from 'vitest';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));

vi.mock('./windows-native-image-recognition-bridge.js', () => ({
  probeWindowsNativeImageRecognition: probe,
  describeImageWithWindowsNativeApi: vi.fn(() => ''),
}));

import {
  ImageDescriptionUnavailableError,
  ReasoningVisionImageDescriptionProvider,
  createReasoningVisionDescribeFn,
  describeImage,
  inferImagePayloadTier,
} from './image-description-bridge.js';
import { getReasoningPayloadScope, type ReasoningPayloadScope } from './reasoning-egress-scope.js';
import type { ReasoningBackend, ReasoningImageAttachment } from './reasoning-backend-contracts.js';
import { pathResolver } from './path-resolver.js';

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

beforeEach(() => {
  probe.mockReturnValue({ ocr: false, description: false, reason: 'requires Windows' });
});

describe('describeImage with the reasoning_vision provider', () => {
  it('describes through the vision channel when no native describer exists', async () => {
    const calls: VisionCall[] = [];
    const result = await describeImage(
      { path: 'active/shared/tmp/screens/shot.png', kind: 'accessible' },
      { resolveBackend: () => visionBackend(calls) }
    );

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('reasoning_vision');
    expect(result.description).toBe('A login form with two fields.');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toMatch(/alt text/);
    expect(calls[0].images).toEqual([
      {
        path: pathResolver.rootResolve('active/shared/tmp/screens/shot.png'),
        media_type: 'image/png',
      },
    ]);
    expect(calls[0].scope).toMatchObject({ tier: 'public', purpose: 'image description' });
  });

  it('raises a declared tier to the tier implied by the image path, never lowers it', async () => {
    const calls: VisionCall[] = [];
    await describeImage(
      { path: 'active/missions/confidential/MSN-X/evidence/shot.jpg' },
      { tier: 'public', tenant_slug: 'acme', resolveBackend: () => visionBackend(calls) }
    );
    expect(calls[0].images[0].media_type).toBe('image/jpeg');
    expect(calls[0].scope).toMatchObject({ tier: 'confidential', tenant_slug: 'acme' });

    await describeImage(
      { path: 'active/shared/tmp/shot.png' },
      { tier: 'personal', resolveBackend: () => visionBackend(calls) }
    );
    expect(calls[1].scope?.tier).toBe('personal');
  });

  it('fails explicitly with a typed error when the backend is text-only', async () => {
    const error = await describeImage(
      { path: 'active/shared/tmp/shot.png' },
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
      { path: 'active/shared/tmp/shot.png' },
      { resolveBackend: () => backend }
    );
    expect(result).toMatchObject({ status: 'failed', provider: 'reasoning_vision' });
    expect(result.error).toMatch(/vision api down/);
  });

  it('refuses media types the vision channel cannot carry', async () => {
    const calls: VisionCall[] = [];
    const result = await describeImage(
      { path: 'active/shared/tmp/shot.bmp' },
      { resolveBackend: () => visionBackend(calls) }
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/VISION_UNSUPPORTED_MEDIA_TYPE/);
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
      describeFn({ path: 'active/shared/tmp/tile.png', prompt: 'Describe this tile.' })
    ).resolves.toBe('Tile shows a toolbar.');
    expect(calls[0].prompt).toBe('Describe this tile.');
  });

  it('throws VISION_BACKEND_TEXT_ONLY for a text-only backend', async () => {
    const describeFn = createReasoningVisionDescribeFn({ resolveBackend: () => textOnlyBackend() });
    const error = await describeFn({ path: 'active/shared/tmp/tile.png' }).catch(
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
