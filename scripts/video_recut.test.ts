import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  render: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@agent/core/video', () => ({
  parseVideoRecutRequest: (request: unknown) => request,
  prepareVideoRecut: mocks.prepare,
  renderVideoRecut: mocks.render,
}));
vi.mock('@agent/core/secure-io', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io')),
  safeRealpath: (value: string) => value,
  assertSafeRepositoryPath: (value: string) => value,
  safeReadFile: mocks.read,
}));

import { runVideoRecutCommand } from './video_recut.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockReturnValue('{}');
  mocks.prepare.mockResolvedValue({
    bundle_dir: 'prepared-bundle',
    index_html: 'prepared-index',
    source_map_path: 'prepared-map',
    duration_sec: 3,
  });
  mocks.render.mockResolvedValue({ output_path: 'rendered-output' });
});

describe('video recut CLI', () => {
  it('accepts the shared JSON flag without enabling rendering', async () => {
    const print = vi.fn();
    await runVideoRecutCommand(
      ['--input', pathResolver.sharedTmp('cli-recut/request.json'), '--json'],
      print
    );
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith(expect.objectContaining({ status: 'prepared' }));
  });

  it('renders only with explicit opt-in and reports the resulting artifact', async () => {
    const print = vi.fn();
    await runVideoRecutCommand(
      ['--input', pathResolver.sharedTmp('cli-recut/request.json'), '--render', '--json'],
      print
    );
    expect(mocks.render).toHaveBeenCalledWith(await mocks.prepare.mock.results[0].value);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rendered', output_path: 'rendered-output' })
    );
  });

  it('rejects a request file outside scratch before reading or preparing it', async () => {
    await expect(
      runVideoRecutCommand(['--input', pathResolver.rootResolve('request.json')], vi.fn())
    ).rejects.toThrow('local file');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
