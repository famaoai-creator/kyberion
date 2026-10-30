import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  secret: vi.fn(() => 'synthetic-obs-password'),
  client: vi.fn(),
  apply: vi.fn(),
  list: vi.fn(),
  reachable: vi.fn(),
}));
vi.mock('../obs-virtual-camera-output.js', () => ({
  ObsVirtualCamera: class {
    constructor(options: unknown) {
      mocks.client(options);
    }
    applySourceFilter = mocks.apply;
    listSourceFilters = mocks.list;
    checkReachable = mocks.reachable;
  },
}));
vi.mock('../secret/secret-guard.js', () => ({ getSecret: mocks.secret }));
vi.mock('../chain-integrity.js', async (original) => ({
  ...(await original<typeof import('../chain-integrity.js')>()),
  resolveAuditChainKey: () => 'synthetic-install-key',
}));
import {
  createObsVideoFilterProvider,
  toObsVideoFilterRequest,
} from './obs-video-filter-provider.js';
import type { VideoFilterRequest } from './video-filter.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret.mockReturnValue('synthetic-obs-password');
});

describe('OBS video filter adapter', () => {
  it.each([
    ['#ff0000', 0xff0000ff],
    ['#0000ff', 0xffff0000],
    ['#123456', 0xff563412],
  ])('packs RGB %s as unsigned OBS ABGR without swapping red and blue', (color, expected) => {
    const translated = toObsVideoFilterRequest({
      source_id: 'cam',
      filter_id: 'key',
      type: 'chroma_key',
      settings: { color: 'custom', custom_color: color as string },
    });
    expect(translated.settings).toMatchObject({ key_color: expected });
  });
  it('declares capabilities without reading credentials or connecting', () => {
    const provider = createObsVideoFilterProvider();
    expect(provider.capabilities.filter_types).toEqual(['color_correction', 'chroma_key', 'crop']);
    expect(provider.capabilities.local_only).toBe(true);
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        source_id: 'cam',
        filter_id: 'color',
        type: 'color_correction',
        settings: { hue_degrees: 30, opacity: 0.5 },
      },
      {
        sourceName: 'cam',
        filterName: 'color',
        kind: 'color_filter_v2',
        settings: { hue_shift: 30, opacity: 0.5 },
        enabled: true,
      },
    ],
    [
      {
        source_id: 'cam',
        filter_id: 'key',
        type: 'chroma_key',
        settings: { color: 'custom', custom_color: '#123456', similarity: 100 },
      },
      {
        sourceName: 'cam',
        filterName: 'key',
        kind: 'chroma_key_filter_v2',
        settings: { key_color_type: 'custom', key_color: 0xff563412, similarity: 100 },
        enabled: true,
      },
    ],
    [
      {
        source_id: 'cam',
        filter_id: 'crop',
        type: 'crop',
        settings: { relative: false, width: 640, height: 480, left: 1 },
        enabled: false,
      },
      {
        sourceName: 'cam',
        filterName: 'crop',
        kind: 'crop_filter',
        settings: { relative: false, cx: 640, cy: 480, left: 1 },
        enabled: false,
      },
    ],
  ])('translates the public contract only inside the adapter', (input, expected) => {
    expect(toObsVideoFilterRequest(input as VideoFilterRequest)).toEqual(expected);
  });

  it('captures target credentials and settings but defers mutation until commit', async () => {
    const options = { port: 4455 };
    const provider = createObsVideoFilterProvider(options);
    const input: VideoFilterRequest = {
      source_id: 'cam',
      filter_id: 'color',
      type: 'color_correction',
      settings: { hue_degrees: 20 },
    };
    const prepared = await provider.prepareApply(input);
    expect(prepared.target_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.target_id).not.toContain('synthetic-obs-password');
    expect(mocks.apply).not.toHaveBeenCalled();
    options.port = 5555;
    input.settings.hue_degrees = 50;
    mocks.secret.mockReturnValue('changed-password');
    mocks.apply.mockResolvedValue({
      filterName: 'color',
      filterKind: 'color_filter_v2',
      filterEnabled: true,
      filterIndex: 0,
    });
    await prepared.commit();
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { hue_shift: 20 } })
    );
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 4455, password: 'synthetic-obs-password' })
    );
    const changed = await provider.prepareApply(input);
    expect(changed.target_id).not.toBe(prepared.target_id);
  });

  it('keeps unsupported native filters opaque during inspection', async () => {
    mocks.list.mockResolvedValue([
      { filterName: 'known', filterKind: 'crop_filter', filterEnabled: false, filterIndex: 0 },
      {
        filterName: 'plugin',
        filterKind: 'secret_plugin_filter',
        filterEnabled: true,
        filterIndex: 1,
        filterSettings: { password: 'hidden' },
      },
    ]);
    expect(await createObsVideoFilterProvider().list('cam')).toEqual([
      { filter_id: 'known', type: 'crop', enabled: false, index: 0 },
      { filter_id: 'plugin', type: 'unsupported', enabled: true, index: 1 },
    ]);
  });

  it('refuses remote endpoints and invalid settings before credential resolution', async () => {
    expect(() => createObsVideoFilterProvider({ host: 'remote.example' })).toThrow(
      '[VIDEO_FILTER_TARGET_INVALID]'
    );
    await expect(
      createObsVideoFilterProvider().prepareApply({
        source_id: 'cam',
        filter_id: 'color',
        type: 'color_correction',
        settings: { hue_shift: 20 },
      } as never)
    ).rejects.toThrow('[VIDEO_FILTER_INVALID]');
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });
});
