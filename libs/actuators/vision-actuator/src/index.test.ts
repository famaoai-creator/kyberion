import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeExistsSync: vi.fn(() => true),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
  executeServicePreset: vi.fn(),
  loggerWarn: vi.fn(),
  recognize: vi.fn(),
  describeImage: vi.fn(),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeReadFile: mocks.safeReadFile,
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
}));

vi.mock('@agent/core/service-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/service-engine')>()),
  executeServicePreset: mocks.executeServicePreset,
}));

vi.mock('@agent/core/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/core')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: mocks.loggerWarn,
    },
  };
});

vi.mock('@agent/core/image-description-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/image-description-bridge')>()),
  describeImage: mocks.describeImage,
}));

vi.mock('tesseract.js', () => ({
  recognize: mocks.recognize,
  createWorker: vi.fn(async () => ({
    load: vi.fn(),
    loadLanguage: vi.fn(),
    initialize: vi.fn(),
    recognize: vi.fn(async () => ({
      data: {
        text: 'hello world',
        confidence: 93,
      },
    })),
    terminate: vi.fn(),
  })),
}));

describe('vision-actuator legacy facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeLstat.mockReturnValue({ isFile: () => true });
  });

  it('routes legacy generation actions to media-generation', async () => {
    mocks.executeServicePreset.mockResolvedValue({ prompt_id: 'legacy' });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'generate_image',
      params: { workflow_path: 'active/shared/tmp/legacy.json' },
    });

    expect(mocks.loggerWarn).toHaveBeenCalled();
    expect(mocks.executeServicePreset).toHaveBeenCalledWith('media-generation', 'generate_image', {
      workflow_path: 'active/shared/tmp/legacy.json',
    });
    expect(result).toEqual({ prompt_id: 'legacy' });
  });

  it('rejects non-legacy actions while vision is narrowed to perception', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'analyze_image',
        params: {},
      })
    ).rejects.toThrow('Vision actuator is being narrowed to perception workflows');
  });

  it('supports inspect_image as a perception action', async () => {
    mocks.safeReadFile.mockReturnValue(Buffer.from('png'));
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'inspect_image',
      params: { path: 'active/shared/tmp/example.png' },
    });

    expect(result).toEqual({
      status: 'succeeded',
      path: 'active/shared/tmp/example.png',
      bytes: 3,
      extension: '.png',
      mime_guess: 'image/png',
    });
  });

  it('rejects inspect_image paths outside the repository root', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'inspect_image',
        params: { path: '../../etc/passwd' },
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
    expect(mocks.safeReadFile).not.toHaveBeenCalled();
  });

  it('rejects a directory inspect_image path before reading it', async () => {
    mocks.safeLstat.mockReturnValue({ isFile: () => false });
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'inspect_image',
        params: { path: 'active/shared/tmp/image-directory' },
      })
    ).rejects.toThrow('[VISION_RESOURCE_FILE]');
    expect(mocks.safeReadFile).not.toHaveBeenCalled();
  });

  it('supports ocr_image as a perception action', async () => {
    mocks.recognize.mockResolvedValue({ data: { text: 'hello world', confidence: 93 } });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'ocr_image',
      params: {
        path: 'active/shared/tmp/example.png',
        language: 'eng',
        provider_preference: ['tesseract'],
      },
    });

    expect(result).toEqual({
      status: 'succeeded',
      path: 'active/shared/tmp/example.png',
      language: 'eng',
      text: 'hello world',
      confidence: 93,
      lines: undefined,
      provider: 'tesseract',
      // Stamped by the router from the provider's own declaration, so a caller
      // that asked for a local-only read can verify the image stayed here.
      provider_data_egress: 'none',
    });
  });

  it('supports describe_image through the image description provider', async () => {
    mocks.describeImage.mockResolvedValue({
      status: 'succeeded',
      provider: 'windows_native',
      description: 'A test image',
    });
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'describe_image',
        params: { path: 'active/shared/tmp/example.png', kind: 'brief' },
      })
    ).resolves.toEqual({
      status: 'succeeded',
      path: 'active/shared/tmp/example.png',
      description: 'A test image',
      provider: 'windows_native',
    });
  });

  it('runs perception pipeline steps through the shared preflight boundary', async () => {
    mocks.safeReadFile.mockReturnValue(Buffer.from('png'));
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'pipeline',
        steps: [
          {
            type: 'capture',
            action: 'inspect_image',
            params: { path: 'active/shared/tmp/example.png' },
          },
        ],
      })
    ).resolves.toEqual({
      status: 'succeeded',
      results: [
        {
          status: 'succeeded',
          path: 'active/shared/tmp/example.png',
          bytes: 3,
          extension: '.png',
          mime_guess: 'image/png',
        },
      ],
    });
  });
});
