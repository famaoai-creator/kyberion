import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  executeServicePreset: vi.fn(),
  loggerWarn: vi.fn(),
  recognize: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    executeServicePreset: mocks.executeServicePreset,
    logger: {
      ...actual.logger,
      warn: mocks.loggerWarn,
    },
  };
});

vi.mock('tesseract.js', () => ({
  recognize: mocks.recognize,
}));

describe('vision-actuator legacy facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    await expect(handleAction({
      action: 'analyze_image',
      params: {},
    })).rejects.toThrow('Vision actuator is being narrowed to perception workflows');
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

  it('supports ocr_image as a perception action', async () => {
    mocks.recognize.mockResolvedValue({ data: { text: 'hello world', confidence: 93 } });
    const { handleAction } = await import('./index.js');

    const result = await handleAction({
      action: 'ocr_image',
      params: { path: 'active/shared/tmp/example.png', language: 'eng' },
    });

    expect(result).toEqual({
      status: 'succeeded',
      path: 'active/shared/tmp/example.png',
      language: 'eng',
      text: 'hello world',
      confidence: 93,
    });
  });
});
