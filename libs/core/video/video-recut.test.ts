import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  copy: vi.fn(),
  exists: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  backend: vi.fn(),
  policy: vi.fn(),
  workspace: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock('../secure-io.js', async () => ({
  ...(await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js')),
  safeExecResultAsync: mocks.exec,
  safeReadFile: mocks.read,
  safeWriteFile: mocks.write,
  safeCopyFileSync: mocks.copy,
  safeExistsSync: mocks.exists,
  safeRealpath: mocks.realpath,
  assertSafeRepositoryPath: (value: string) => path.resolve(value),
  safeStat: mocks.stat,
  safeMkdir: mocks.mkdir,
  safeReaddir: mocks.readdir,
}));
vi.mock('../tool/tool-binary-resolvers.js', () => ({ resolveFfprobeBin: () => 'ffprobe' }));
vi.mock('../media/media-backend-registry.js', () => ({ resolveVideoBackend: mocks.backend }));
vi.mock('./video-render-runtime-policy.js', () => ({ getVideoRenderRuntimePolicy: mocks.policy }));
vi.mock('../workforce/workspace-ledger.js', async () => ({
  ...(await vi.importActual<typeof import('../workforce/workspace-ledger.js')>(
    '../workforce/workspace-ledger.js'
  )),
  createScratchWorkspace: mocks.workspace,
  listWorkspaces: mocks.workspaces,
}));

import {
  parseVideoRecutRequest,
  planVideoRecut,
  prepareVideoRecut,
  renderVideoRecut,
  type VideoRecutRequest,
} from './video-recut.js';
import { workspacesRootDir } from '../workforce/workspace-ledger.js';

const source = pathResolver.sharedTmp('recut-test/input.mp4');
const subtitles = pathResolver.sharedTmp('recut-test/captions.vtt');
const bundle = pathResolver.sharedTmp('recut-test/bundle');
const automaticBundle = path.join(workspacesRootDir(), 'ws-recut-test');
const request: VideoRecutRequest = {
  source_path: source,
  subtitles_path: subtitles,
  bundle_dir: bundle,
  padding: { before_sec: 0.1, after_sec: 0.2 },
  gap_threshold_sec: 1,
};
const cues = [
  { start_sec: 1, end_sec: 2, text: 'First' },
  { start_sec: 5, end_sec: 6, text: 'Second' },
];
const metadata = (duration = 10, audio = true) => ({
  status: 0,
  stdout: JSON.stringify({
    format: { duration: String(duration) },
    streams: [
      { codec_type: 'video', width: 640, height: 360, avg_frame_rate: '30/1' },
      ...(audio ? [{ codec_type: 'audio' }] : []),
    ],
  }),
  stderr: '',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.realpath.mockImplementation((value: string) => path.resolve(value));
  mocks.exists.mockReturnValue(false);
  mocks.stat.mockReturnValue({ isFile: () => true, isDirectory: () => true });
  mocks.readdir.mockReturnValue([]);
  mocks.workspace.mockReturnValue({ path: automaticBundle });
  mocks.workspaces.mockReturnValue([
    {
      path: automaticBundle,
      kind: 'scratch-dir',
      live: true,
      owner: { session_id: 'video-recut-test' },
    },
  ]);
  mocks.read.mockReturnValue(
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst\n\n00:00:05.000 --> 00:00:06.000\nSecond\n'
  );
  mocks.exec.mockResolvedValue(metadata());
  mocks.policy.mockReturnValue({
    render: {
      enable_backend_rendering: true,
      backend: 'hyperframes_cli',
      quality: 'standard',
      command_timeout_ms: 30000,
      allowed_output_formats: ['mp4'],
    },
  });
  mocks.backend.mockReturnValue({
    provider: 'hyperframes',
    status: 'active',
    command: 'renderer',
    args: ['render'],
    supports: { artifact_formats: ['mp4'] },
    video_render: {
      argument_template: ['{bundle_dir}', '--output', '{output_path}', '--fps', '{fps}'],
    },
  });
});

describe('subtitle gap recut planning', () => {
  it('remaps retained source offsets and shortens only the long gap', () => {
    const plan = planVideoRecut(request, cues, 10);
    expect(plan.clips).toEqual([
      { id: 'shot-1', source_start: 0.9, source_end: 2.2, output_start: 0, duration: 1.3 },
      { id: 'shot-2', source_start: 4.9, source_end: 6.2, output_start: 1.3, duration: 1.3 },
    ]);
    expect(plan.captions.map((c) => c.output_start)).toEqual([0.1, 1.4]);
    expect(plan.edited_duration).toBe(2.6);
    expect(plan.duration_sec).toBe(2.6);
  });
  it('retains gaps at the threshold and clamps padding to the selected window', () => {
    const plan = planVideoRecut(
      { ...request, window: { start_sec: 1, end_sec: 3 } },
      [cues[0], { start_sec: 3, end_sec: 4, text: 'Excluded' }],
      10
    );
    expect(plan.clips[0].source_start).toBe(1);
    expect(plan.excluded_cue_count).toBe(1);
    expect(
      planVideoRecut(request, [cues[0], { start_sec: 3, end_sec: 4, text: 'Next' }], 10).clips
    ).toHaveLength(1);
  });
  it('keeps exact adjacent output audio intervals across varied fractional durations', () => {
    const varied = Array.from({ length: 7 }, (_, i) => ({
      start_sec: i * 5 + 0.123 + i * 0.013,
      end_sec: i * 5 + 1.237 + i * 0.027,
      text: `Cue ${i}`,
    }));
    const plan = planVideoRecut(request, varied, 40);
    expect(plan.clips).toHaveLength(7);
    for (let i = 1; i < plan.clips.length; i++)
      expect(plan.clips[i].output_start).toBe(
        plan.clips[i - 1].output_start + plan.clips[i - 1].duration
      );
  });
  it('bounds cue count, source duration and attribution resources', () => {
    expect(() => planVideoRecut(request, Array(10001).fill(cues[0]), 10)).toThrow('10000');
    expect(() => planVideoRecut(request, cues, 86401)).toThrow('24 hours');
    expect(() =>
      parseVideoRecutRequest({
        ...request,
        attribution: { title: 'Credit', lines: Array(21).fill('Line') },
      })
    ).toThrow('attribution');
    expect(() =>
      parseVideoRecutRequest({
        ...request,
        attribution: { title: 'Credit', lines: ['x'.repeat(2049)] },
      })
    ).toThrow('attribution');
  });
  it('pads final duration to a full frame without shifting speech or captions', () => {
    const plan = planVideoRecut(
      { ...request, padding: { before_sec: 0, after_sec: 0 } },
      [{ start_sec: 0, end_sec: 1.001, text: 'Precise' }],
      2
    );
    expect(plan.duration_sec).toBe(31 / 30);
    expect(plan.captions[0].duration).toBe(1.001);
    expect(plan.duration_sec - plan.edited_duration).toBeLessThan(1 / 30);
  });
  it.each([
    [{ start_sec: 1, end_sec: 11, text: 'Outside' }],
    [
      { start_sec: 1, end_sec: 2, text: 'A' },
      { start_sec: 1.5, end_sec: 3, text: 'Overlap' },
    ],
    [{ start_sec: Number.NaN, end_sec: 2, text: 'Invalid' }],
    [{ start_sec: 1, end_sec: 2, text: '' }],
  ])('rejects invalid cues %j', (...invalid) => {
    expect(() => planVideoRecut(request, invalid, 10)).toThrow();
  });
  it('rejects partial-window captions, invalid durations, padding and unknown input fields', () => {
    expect(() =>
      planVideoRecut({ ...request, window: { start_sec: 1.5, end_sec: 6 } }, cues, 10)
    ).toThrow('boundary');
    expect(() => planVideoRecut(request, cues, Infinity)).toThrow('duration');
    expect(() => parseVideoRecutRequest({ ...request, gap_threshold_sec: 0 })).toThrow('threshold');
    expect(() => parseVideoRecutRequest({ ...request, unexpected: true })).toThrow('unknown');
  });
  it('rejects URI schemes, outside paths, traversal, control characters and ambiguous slashes', () => {
    for (const invalid of [
      'remote:' + path.sep.repeat(2) + 'asset',
      'file:' + source,
      '../outside.mp4',
      source + '\u0000',
      ...(path.sep !== '\\' ? [source + '\\escape'] : []),
    ]) {
      expect(() => parseVideoRecutRequest({ ...request, source_path: invalid })).toThrow();
    }
    expect(
      parseVideoRecutRequest({
        ...request,
        source_path: pathResolver.sharedTmp('space folder/input.mp4'),
      }).source_path
    ).toContain('space folder');
    expect(parseVideoRecutRequest(request).source_path).toBe(source);
  });
});

describe('local preparation and exact renderer', () => {
  it('allocates an omitted output directory through the shared scratch workspace helper', async () => {
    const { bundle_dir: _omitted, ...automatic } = request;
    const prepared = await prepareVideoRecut(automatic);
    expect(prepared.bundle_dir).toBe(automaticBundle);
    expect(mocks.workspace).toHaveBeenCalledWith({
      session_id: expect.stringMatching(/^video-recut-/u),
    });
    mocks.exec
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(metadata(prepared.duration_sec));
    await expect(renderVideoRecut(prepared)).resolves.toEqual({
      output_path: path.join(automaticBundle, 'output.mp4'),
    });
    mocks.workspaces.mockReturnValue([]);
    await expect(renderVideoRecut(prepared)).rejects.toThrow('registered');
  });
  it('rejects unsupported source containers before allocating or writing a bundle', async () => {
    await expect(
      prepareVideoRecut({ ...request, source_path: pathResolver.sharedTmp('recut-test/input.txt') })
    ).rejects.toThrow('container');
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });
  it('keeps native audio, escapes text and emits no remote script dependency', async () => {
    mocks.read.mockReturnValue(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&lt;caption&gt; &amp; words\n'
    );
    const prepared = await prepareVideoRecut({
      ...request,
      attribution: { title: '<unsafe>', lines: ['</script><img onerror="run()">'] },
    });
    const html = mocks.write.mock.calls.find((call) => call[0] === prepared.index_html)?.[1];
    expect(html).toContain('data-has-audio="true"');
    expect(html).toContain('data-media-start="0.9"');
    const creditHtml = mocks.write.mock.calls.find(
      (call) => call[0] === path.join(bundle, 'compositions/credits.html')
    )?.[1];
    expect(html).toContain('id="recut-credits"');
    expect(html).toContain('data-composition-src="compositions/credits.html"');
    expect(creditHtml).toContain('<template><div id="root" data-composition-id="recut-credits"');
    expect(creditHtml).toContain('&lt;unsafe&gt;');
    expect(creditHtml).toContain('&lt;/script&gt;&lt;img onerror=&quot;run()&quot;&gt;');
    expect(html).toContain('&lt;caption&gt; &amp; words');
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(mocks.copy).toHaveBeenCalledWith(source, path.join(bundle, 'source.mp4'));
  });
  it('rejects physical symlink escapes, aliases and nonempty output bundles before writing', async () => {
    mocks.realpath.mockImplementation((value: string) =>
      value === source ? pathResolver.rootResolve('knowledge/private.mp4') : value
    );
    await expect(prepareVideoRecut(request)).rejects.toThrow('symlink escape');
    mocks.realpath.mockImplementation((value: string) => value);
    await expect(
      prepareVideoRecut({ ...request, bundle_dir: path.dirname(source) })
    ).rejects.toThrow('alias');
    mocks.exists.mockReturnValue(true);
    mocks.readdir.mockReturnValue(['existing']);
    await expect(prepareVideoRecut(request)).rejects.toThrow('nonempty');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects source without audio and malformed cues rather than silently dropping them', async () => {
    mocks.exec.mockResolvedValue(metadata(10, false));
    await expect(prepareVideoRecut(request)).rejects.toThrow('audio');
    mocks.exec.mockResolvedValue(metadata());
    mocks.read.mockReturnValue('WEBVTT\n\ninvalid --> 00:00:02.000\nBad\n');
    await expect(prepareVideoRecut(request)).rejects.toThrow('Malformed');
  });
  it('refuses disabled rendering and propagates failures without fallback invocation', async () => {
    const prepared = await prepareVideoRecut(request);
    mocks.exec.mockClear();
    mocks.policy.mockReturnValue({ render: { enable_backend_rendering: false } });
    await expect(renderVideoRecut(prepared)).rejects.toThrow('disabled');
    expect(mocks.exec).not.toHaveBeenCalled();
    mocks.policy.mockReturnValue({
      render: {
        enable_backend_rendering: true,
        backend: 'hyperframes_cli',
        quality: 'standard',
        command_timeout_ms: 30000,
        allowed_output_formats: ['mp4'],
      },
    });
    mocks.exec.mockResolvedValue({ status: 1, stdout: '', stderr: 'Failed' });
    await expect(renderVideoRecut(prepared)).rejects.toThrow('no fallback');
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
  it('uses registered arguments and checks final audio, duration and dimensions', async () => {
    const prepared = await prepareVideoRecut(request);
    mocks.exec.mockClear();
    mocks.exec
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(metadata(prepared.duration_sec));
    await expect(renderVideoRecut(prepared)).resolves.toEqual({
      output_path: path.join(bundle, 'output.mp4'),
    });
    expect(mocks.exec.mock.calls[0].slice(0, 2)).toEqual([
      'renderer',
      ['render', bundle, '--output', path.join(bundle, 'output.mp4'), '--fps', '30'],
    ]);
    mocks.exec
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(metadata(prepared.duration_sec, false));
    await expect(renderVideoRecut(prepared)).rejects.toThrow('audio');
    mocks.exec
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(metadata(prepared.duration_sec + 1));
    await expect(renderVideoRecut(prepared)).rejects.toThrow('duration');
    const wrongFps = metadata(prepared.duration_sec);
    const wrongMeta = JSON.parse(wrongFps.stdout);
    wrongMeta.streams[0].avg_frame_rate = '24/1';
    mocks.exec
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ...wrongFps, stdout: JSON.stringify(wrongMeta) });
    await expect(renderVideoRecut(prepared)).rejects.toThrow('fps');
  });
});
