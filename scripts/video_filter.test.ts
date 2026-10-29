import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  apply: vi.fn(),
  list: vi.fn(),
  providers: vi.fn(),
  resolve: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@agent/core/video/video-filter-bootstrap', () => ({
  installBuiltinVideoFilterProviders: mocks.install,
}));
vi.mock('@agent/core/video/video-filter', async (original) => ({
  ...(await original<typeof import('@agent/core/video/video-filter')>()),
  applyVideoFilter: mocks.apply,
  listVideoFilters: mocks.list,
  listVideoFilterProviders: mocks.providers,
  resolveVideoFilterProvider: mocks.resolve,
}));
vi.mock('@agent/core/foundation/json', async (original) => ({
  ...(await original<typeof import('@agent/core/foundation/json')>()),
  readJson: mocks.read,
}));
import { runVideoFilter } from './video_filter.js';

const request = () => ({
  source_id: 'camera-main',
  filter_id: 'portrait-color',
  type: 'color_correction' as const,
  settings: { saturation: -1 },
});
const provider = () => ({
  provider_id: 'test-renderer',
  capabilities: { filter_types: ['color_correction'], local_only: true },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockImplementation(() => request());
  mocks.providers.mockReturnValue([provider()]);
  mocks.resolve.mockReturnValue(provider());
  mocks.list.mockResolvedValue([]);
  mocks.apply.mockResolvedValue({ provider_id: 'test-renderer', filter_id: 'portrait-color' });
});
describe('provider-neutral video filter CLI', () => {
  it('reports declared capabilities separately from availability without inspecting a source', async () => {
    expect(await runVideoFilter(['inspect'])).toEqual({
      providers: [{ ...provider(), availability: 'not_probed' }],
    });
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('routes source inspection to the explicitly resolved provider', async () => {
    mocks.list.mockResolvedValue([
      { filter_id: 'portrait-color', type: 'color_correction', enabled: true, index: 0 },
    ]);
    const result = await runVideoFilter([
      'inspect',
      '--source',
      'camera-main',
      '--provider',
      'test-renderer',
    ]);
    expect(mocks.resolve).toHaveBeenCalledWith('test-renderer');
    expect(mocks.list).toHaveBeenCalledWith('camera-main', 'test-renderer');
    expect(result).toMatchObject({ provider_id: 'test-renderer', source_id: 'camera-main' });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('keeps dry-run structural and does not install providers or admit an effect', async () => {
    const result = await runVideoFilter(
      ['apply', '--input', 'filter.json', '--provider', 'test-renderer'],
      { dryRun: true }
    );
    expect(result).toMatchObject({
      dry_run: true,
      validation: 'contract_only',
      requested_provider: 'test-renderer',
      request: request(),
    });
    expect(mocks.read).toHaveBeenCalledWith('filter.json');
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('does not expose provider-specific capability metadata', async () => {
    const supplied = provider();
    mocks.providers.mockReturnValue([
      {
        ...supplied,
        capabilities: { ...supplied.capabilities, private_token: 'synthetic-secret' },
      },
    ]);
    const result = await runVideoFilter(['inspect']);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(result).toEqual({ providers: [{ ...provider(), availability: 'not_probed' }] });
  });
  it('rejects vendor-specific requests and invalid settings before provider setup', async () => {
    mocks.read.mockReturnValue({
      sourceName: 'Camera',
      filterName: 'color',
      kind: 'color_filter_v2',
      settings: {},
    });
    await expect(runVideoFilter(['apply', '--input', 'filter.json'])).rejects.toThrow();
    mocks.read.mockReturnValue({ ...request(), settings: { saturation: Infinity } });
    await expect(runVideoFilter(['apply', '--input', 'filter.json'])).rejects.toThrow();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('dispatches a generic apply through the governed facade without selecting a vendor itself', async () => {
    const result = await runVideoFilter([
      'apply',
      '--input',
      'filter.json',
      '--provider',
      'test-renderer',
    ]);
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining(request()), 'test-renderer');
    expect(result).toMatchObject({ provider_id: 'test-renderer' });
  });
  it.each([
    ['apply'],
    ['apply', '--input', 'filter.json', '--source', 'camera-main'],
    ['inspect', '--input', 'filter.json'],
    ['inspect', '--source', ' '],
    ['inspect', '--source', 'camera\nprivate'],
    ['inspect', '--port', '4455'],
    ['unknown'],
  ])('rejects invalid command arguments before setup: %j', async (...args) => {
    await expect(runVideoFilter(args as string[])).rejects.toThrow();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
