import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';

const mocks = vi.hoisted(() => ({
  buildVideoBrief: vi.fn(),
  describeScreenDelta: vi.fn(),
  handleMarkElements: vi.fn(),
  safeExistsSync: vi.fn(() => true),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExistsSync: mocks.safeExistsSync,
  safeLstat: mocks.safeLstat,
}));

vi.mock('@agent/core/video-ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/video-ingest')>()),
  buildVideoBrief: mocks.buildVideoBrief,
}));

vi.mock('@agent/core/dirty-tile-describer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/dirty-tile-describer')>()),
  describeScreenDelta: mocks.describeScreenDelta,
}));

vi.mock('./mark-elements.js', () => ({ handleMarkElements: mocks.handleMarkElements }));

const brief = {
  source: { kind: 'url', url: 'https://www.youtube.com/watch?v=abc' },
  content_key: 'k',
  metadata: { title: 't', duration_sec: 10 },
  chapters: [],
  transcript: null,
  keyframes: [],
  cache_hit: false,
  warnings: [],
};

const deltaResult = {
  session_id: 's1',
  image: { width: 8, height: 8 },
  grid: { cols: 1, rows: 1 },
  tiles: [],
  stats: {
    tiles_total: 1,
    tiles_described: 0,
    describe_calls_saved: 1,
    approx_tokens_saved: 256,
    stale_tiles: 0,
  },
  state_path: 'x',
};

describe('vision-actuator perception ops dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeLstat.mockReturnValue({ isFile: () => true });
  });

  it('fetch_video builds a brief from the url and forwards approval context', async () => {
    mocks.buildVideoBrief.mockResolvedValue({ status: 'ok', brief });
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'fetch_video',
      params: {
        url: 'https://www.youtube.com/watch?v=abc',
        language: 'en',
        max_keyframes: 3,
        approval: { agent_id: 'agent-a' },
      },
    });
    expect(mocks.buildVideoBrief).toHaveBeenCalledWith(
      { kind: 'url', url: 'https://www.youtube.com/watch?v=abc' },
      { language: 'en', max_keyframes: 3, approval: { agent_id: 'agent-a' } }
    );
    expect(result).toEqual({ status: 'succeeded', brief });
  });

  it('fetch_video returns approval_required instead of throwing', async () => {
    mocks.buildVideoBrief.mockResolvedValue({
      status: 'approval_required',
      code: 'APPROVAL_REQUIRED',
      message: 'needs approval',
      request_id: 'req-1',
    });
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({ action: 'fetch_video', params: { url: 'https://youtu.be/abc' } })
    ).resolves.toEqual({
      status: 'approval_required',
      code: 'APPROVAL_REQUIRED',
      message: 'needs approval',
      request_id: 'req-1',
    });
  });

  it('fetch_video refuses a local path', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({ action: 'fetch_video', params: { source: { kind: 'file', path: 'a.mp4' } } })
    ).rejects.toThrow('[VIDEO_INVALID_PARAMS]');
    expect(mocks.buildVideoBrief).not.toHaveBeenCalled();
  });

  it('build_video_brief accepts a local path and surfaces failures with remediation', async () => {
    mocks.buildVideoBrief.mockResolvedValue({
      status: 'failed',
      code: 'EXTRACTOR_OUTDATED',
      message: 'yt-dlp extractor is outdated',
      remediation: 'pnpm tool:setup -- --tool yt_dlp --apply',
    });
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'build_video_brief',
        params: {
          path: 'active/shared/tmp/clip.mp4',
          mission_id: 'MSN-A',
          input_tier: 'confidential',
        },
      })
    ).rejects.toThrow(/\[VIDEO_EXTRACTOR_OUTDATED\].*tool:setup/);
    expect(mocks.buildVideoBrief).toHaveBeenCalledWith(
      { kind: 'file', path: 'active/shared/tmp/clip.mp4' },
      { input_tier: 'confidential', mission_id: 'MSN-A' }
    );
  });

  it('build_video_brief rejects both url and path', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'build_video_brief',
        params: { path: 'a.mp4', url: 'https://youtu.be/x' },
      })
    ).rejects.toThrow('[VIDEO_INVALID_PARAMS]');
  });

  it('mark_elements dispatches to the Set-of-Marks handler', async () => {
    mocks.handleMarkElements.mockResolvedValue({ marks: [], marks_id: 'm1' });
    const { handleAction } = await import('./index.js');
    const params = { path: 'active/shared/tmp/screen.png', session_id: 's1' };
    await expect(handleAction({ action: 'mark_elements', params })).resolves.toEqual({
      status: 'succeeded',
      marks: [],
      marks_id: 'm1',
    });
    expect(mocks.handleMarkElements).toHaveBeenCalledWith(params);
  });

  it('describe_screen_delta keeps public screens in the default work dir', async () => {
    mocks.describeScreenDelta.mockResolvedValue(deltaResult);
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'describe_screen_delta',
      params: { path: 'active/shared/tmp/screen.png', session_id: 's1', grid: 2 },
    });
    const [input, deps] = mocks.describeScreenDelta.mock.calls[0];
    expect(input).toMatchObject({ session_id: 's1', grid: 2, tier: 'public' });
    expect(deps).toEqual({});
    expect(result).toMatchObject({ status: 'succeeded', tier: 'public', stats: deltaResult.stats });
  });

  it('describe_screen_delta refuses a declared non-public tier without a mission', async () => {
    const { handleDescribeScreenDelta } = await import('./screen-delta.js');
    await expect(
      handleDescribeScreenDelta({
        path: 'active/shared/tmp/screen.png',
        session_id: 's1',
        tier: 'confidential',
      })
    ).rejects.toThrow('[VISION_TIER_SCOPE]');
    expect(mocks.describeScreenDelta).not.toHaveBeenCalled();
  });
});

describe('handleDescribeScreenDelta mission scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeLstat.mockReturnValue({ isFile: () => true });
  });

  it('crops into the mission dir and raises the tier to the mission tier', async () => {
    const { handleDescribeScreenDelta } = await import('./screen-delta.js');
    const missionPath = path.join(pathResolver.rootDir(), 'active/missions/confidential/MSN-X');
    const describeDelta = vi.fn(async () => deltaResult);
    const result = await handleDescribeScreenDelta(
      { path: 'active/shared/tmp/screen.png', session_id: 's1', mission_id: 'MSN-X' },
      { describeDelta, resolveMissionPath: () => missionPath }
    );
    expect(describeDelta).toHaveBeenCalledWith(expect.objectContaining({ tier: 'confidential' }), {
      work_dir: path.join(missionPath, 'tmp', 'vision-tiles'),
      state_dir: path.join(missionPath, 'tmp', 'vision-state'),
    });
    expect(result.tier).toBe('confidential');
  });

  it('infers the tier from a confidential screenshot path', async () => {
    const { handleDescribeScreenDelta } = await import('./screen-delta.js');
    await expect(
      handleDescribeScreenDelta({
        path: 'active/missions/confidential/MSN-X/evidence/screen.png',
        session_id: 's1',
      })
    ).rejects.toThrow('[VISION_TIER_SCOPE] confidential');
  });
});
