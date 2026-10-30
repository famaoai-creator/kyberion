import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const external = vi.hoisted(() => vi.fn());
vi.mock('../governance/external-operation.js', () => ({ runExternalOperation: external }));
import {
  applyVideoFilter,
  listVideoFilters,
  listVideoFilterProviders,
  registerVideoFilterProvider,
  resetVideoFilterProviders,
  resolveVideoFilterProvider,
  validateVideoFilterRequest,
  type VideoFilterProvider,
  type VideoFilterRequest,
} from './video-filter.js';

const request = (): VideoFilterRequest => ({
  source_id: 'camera-1',
  filter_id: 'color-1',
  type: 'color_correction',
  settings: { saturation: -1, hue_degrees: 15 },
});
function softwareProvider(id = 'software') {
  const commit = vi.fn(async () => ({
    filter_id: 'color-1',
    type: 'color_correction' as const,
    enabled: true,
    index: 0,
  }));
  const prepare = vi.fn(async (_request: VideoFilterRequest) => ({
    target_id: 'a'.repeat(64),
    commit,
  }));
  const provider: VideoFilterProvider = {
    provider_id: id,
    capabilities: { filter_types: ['color_correction'], local_only: true },
    probe: vi.fn(async () => ({ available: true })),
    list: vi.fn(async () => []),
    prepareApply: prepare,
  };
  return { provider, prepare, commit };
}
beforeEach(() => {
  vi.clearAllMocks();
  external.mockImplementation(async (_operation, commit) => commit());
});
afterEach(() => resetVideoFilterProviders());

describe('provider-neutral video filters', () => {
  it('uses a non-OBS provider through a dedicated approved effect', async () => {
    const fake = softwareProvider();
    registerVideoFilterProvider(fake.provider);
    const result = await applyVideoFilter(request());
    expect(result).toEqual({
      filter_id: 'color-1',
      type: 'color_correction',
      enabled: true,
      index: 0,
    });
    expect(external).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'video:filter_apply',
        requiresApproval: true,
        delegable: false,
        effect: {
          provider_id: 'software',
          target_id: 'a'.repeat(64),
          request: { ...request(), enabled: true },
        },
      }),
      expect.any(Function),
      expect.any(Function)
    );
    expect(fake.provider.probe).toHaveBeenCalledOnce();
    expect(fake.commit).toHaveBeenCalledOnce();
  });

  it('never commits a denied approval and snapshots settings before waiting', async () => {
    const fake = softwareProvider();
    registerVideoFilterProvider(fake.provider);
    external.mockRejectedValueOnce(new Error('approval required'));
    await expect(applyVideoFilter(request())).rejects.toThrow('approval required');
    expect(fake.commit).not.toHaveBeenCalled();
    const input = request();
    external.mockImplementation(async (_effect, commit) => {
      if (input.type === 'color_correction') input.settings.saturation = 3;
      return commit();
    });
    await applyVideoFilter(input);
    const captured = fake.prepare.mock.calls[1]![0] as VideoFilterRequest;
    expect(captured.settings).toMatchObject({ saturation: -1 });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.settings)).toBe(true);
  });

  it.each([
    { ...request(), type: 'color_filter_v2' },
    { ...request(), settings: { hue_shift: 15 } },
    { ...request(), sourceName: 'native-source' },
    { ...request(), settings: { saturation: Infinity } },
    { ...request(), settings: { opacity: 2 } },
    { ...request(), settings: { __proto__: { brightness: 1 } } },
    { ...request(), type: 'chroma_key', settings: { custom_color: 0xff0000 } },
    { ...request(), type: 'chroma_key', settings: { custom_color: '#12345z' } },
    { ...request(), type: 'chroma_key', settings: { color: 'custom' } },
    { ...request(), type: 'chroma_key', settings: { custom_color: '#123456' } },
    { ...request(), type: 'chroma_key', settings: { color: 'green', custom_color: '#123456' } },
    { ...request(), type: 'crop', settings: { width: 640, height: 480 } },
    { ...request(), type: 'crop', settings: { relative: true, width: 640 } },
    {
      ...request(),
      type: 'crop',
      settings: { relative: false, width: 640, height: 480, right: 10 },
    },
    { ...request(), type: 'crop', settings: { relative: false, width: 0, height: 480 } },
    { ...request(), type: 'crop', settings: { relative: false } },
  ])('rejects native or invalid contracts before provider preparation: %j', async (input) => {
    const fake = softwareProvider();
    registerVideoFilterProvider(fake.provider);
    await expect(applyVideoFilter(input)).rejects.toThrow('[VIDEO_FILTER_INVALID]');
    expect(fake.prepare).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it('rejects accessor payloads without evaluating them', () => {
    const getter = vi.fn();
    const input = Object.defineProperty({}, 'source_id', { enumerable: true, get: getter });
    expect(() => validateVideoFilterRequest(input)).toThrow('[VIDEO_FILTER_INVALID]');
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects unsupported capabilities before resolving a provider target', async () => {
    const fake = softwareProvider();
    registerVideoFilterProvider(fake.provider);
    await expect(
      applyVideoFilter({
        source_id: 'camera-1',
        filter_id: 'crop',
        type: 'crop',
        settings: { relative: true, left: 100 },
      })
    ).rejects.toThrow('[VIDEO_FILTER_UNSUPPORTED]');
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('requires explicit selection when multiple providers exist; never retries another provider', async () => {
    const first = softwareProvider();
    const second = softwareProvider('alternate');
    registerVideoFilterProvider(first.provider);
    registerVideoFilterProvider(second.provider);
    expect(listVideoFilterProviders()).toHaveLength(2);
    expect(() => resolveVideoFilterProvider()).toThrow('[VIDEO_FILTER_SELECTION_REQUIRED]');
    expect(() => resolveVideoFilterProvider('missing')).toThrow('[VIDEO_FILTER_PROVIDER_UNKNOWN]');
    first.commit.mockRejectedValueOnce(new Error('provider failed'));
    await expect(applyVideoFilter(request(), 'software')).rejects.toThrow('provider failed');
    expect(second.prepare).not.toHaveBeenCalled();
    expect(second.commit).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'failed'] as const)(
    'rejects a %s readiness probe before preparation or approval without fallback',
    async (mode) => {
      const first = softwareProvider();
      const second = softwareProvider('alternate');
      registerVideoFilterProvider(first.provider);
      registerVideoFilterProvider(second.provider);
      if (mode === 'unavailable')
        vi.mocked(first.provider.probe).mockResolvedValueOnce({ available: false });
      else
        vi.mocked(first.provider.probe).mockRejectedValueOnce(
          new Error('private transport detail')
        );
      await expect(applyVideoFilter(request(), 'software')).rejects.toThrow(
        '[VIDEO_FILTER_UNAVAILABLE]'
      );
      expect(first.prepare).not.toHaveBeenCalled();
      expect(first.commit).not.toHaveBeenCalled();
      expect(second.provider.probe).not.toHaveBeenCalled();
      expect(second.prepare).not.toHaveBeenCalled();
      expect(external).not.toHaveBeenCalled();
    }
  );

  it('does not allow unbound target identity or claim an unverified result', async () => {
    const fake = softwareProvider();
    registerVideoFilterProvider(fake.provider);
    fake.prepare.mockResolvedValueOnce({ target_id: 'not-a-digest', commit: fake.commit });
    await expect(applyVideoFilter(request())).rejects.toThrow('[VIDEO_FILTER_TARGET_INVALID]');
    expect(external).not.toHaveBeenCalled();
    fake.commit.mockResolvedValueOnce({
      filter_id: 'wrong-filter',
      type: 'color_correction',
      enabled: true,
      index: 0,
    });
    await expect(applyVideoFilter(request())).rejects.toThrow('[VIDEO_FILTER_UNVERIFIED]');
  });

  it('inspects bounded metadata and drops provider-specific fields', async () => {
    const fake = softwareProvider();
    registerVideoFilterProvider(fake.provider);
    vi.mocked(fake.provider.list).mockResolvedValueOnce([
      {
        filter_id: 'native',
        type: 'unsupported',
        enabled: false,
        index: 1,
        secret: 'not-public',
      } as never,
    ]);
    expect(await listVideoFilters('camera-1')).toEqual([
      { filter_id: 'native', type: 'unsupported', enabled: false, index: 1 },
    ]);
    expect(fake.prepare).not.toHaveBeenCalled();
    await expect(listVideoFilters('')).rejects.toThrow('[VIDEO_FILTER_INVALID]');
  });
});
