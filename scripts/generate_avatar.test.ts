import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  safeExistsSync: vi.fn(),
}));

vi.mock('@agent/core/image-generation-bridge', () => ({
  generateImage: mocks.generateImage,
}));

vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return { ...actual, safeExistsSync: mocks.safeExistsSync };
});

describe('generate_avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('emits progress and completion through the supplied printer', async () => {
    mocks.generateImage.mockResolvedValue({ path: '/repo/active/shared/tmp/avatar.png' });

    const { main } = await import('./generate_avatar.js');
    const print = vi.fn();
    await main(
      [
        '--input-photo',
        'active/shared/tmp/face.jpg',
        '--output-path',
        'active/shared/tmp/avatar.png',
      ],
      print
    );

    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: expect.stringContaining('active/shared/tmp/avatar.png'),
      })
    );
    expect(print).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('Generating avatar based on:')
    );
    expect(print).toHaveBeenLastCalledWith(
      'Avatar generated successfully at: /repo/active/shared/tmp/avatar.png'
    );
  });
});
