import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { platform as corePlatform } from './platform.js';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeExistsSync: vi.fn(() => true),
  // voice-engine-registry (main 636acd1f3) filters registry entries with
  // safeStat(...).isFile(); the stub must expose the Stats predicates.
  safeStat: vi.fn(() => ({ size: 4096, isFile: () => true, isDirectory: () => false })),
  safeMoveSync: vi.fn(),
  safeRmSync: vi.fn(),
}));

const VIDEO_BUNDLE_DIR = pathResolver.sharedTmp('video-render-backend-tests/demo');
const NARRATION_PATH = pathResolver.sharedTmp('video-render-backend-tests/narration.aiff');
const MUSIC_PATH = pathResolver.sharedTmp('video-render-backend-tests/music.mp3');

vi.mock('./secure-io.js', async () => {
  const actual = (await vi.importActual('./secure-io.js')) as any;
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeExistsSync: mocks.safeExistsSync,
    safeStat: mocks.safeStat,
    safeMoveSync: mocks.safeMoveSync,
    safeRmSync: mocks.safeRmSync,
  };
});

describe('video render backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(corePlatform, 'getCapabilities').mockResolvedValue({ hasFFmpeg: true } as any);
    vi.spyOn(corePlatform, 'runMediaCommand').mockResolvedValue('');
    mocks.safeExec.mockImplementation((command: string) => {
      if (command === 'ffprobe') return '0\n';
      return '';
    });
  });

  it('reads inherited Node options through the environment registry', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/video-render-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.NODE_OPTIONS');
    expect(source).toContain("getRegisteredEnvText('NODE_OPTIONS')");
  });

  it('returns non-executed when backend rendering is disabled', async () => {
    const { renderVideoCompositionBundle } = await import('./video-render-backend.js');
    const result = await renderVideoCompositionBundle(
      {
        kind: 'video-composition-render-plan',
        version: '1.0.0',
        composition_id: 'demo',
        source_kind: 'video-composition-adf',
        title: 'Demo',
        duration_sec: 3,
        fps: 30,
        width: 1920,
        height: 1080,
        background_color: '#000000',
        output_format: 'mp4',
        bundle_dir: '/tmp/demo',
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: {
          default_bundle_root: 'active/shared/tmp/video-composition',
          copy_declared_assets: false,
        },
        render: {
          allowed_output_formats: ['mp4'],
          enable_backend_rendering: false,
          backend: 'none',
          quality: 'standard',
          command_timeout_ms: 300000,
        },
      }
    );
    expect(result.executed).toBe(false);
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('rejects an output target outside the repository', async () => {
    const { renderVideoCompositionBundle } = await import('./video-render-backend.js');
    await expect(
      renderVideoCompositionBundle(
        {
          kind: 'video-composition-render-plan',
          version: '1.0.0',
          composition_id: 'outside',
          source_kind: 'video-composition-adf',
          title: 'Outside',
          duration_sec: 1,
          fps: 30,
          width: 640,
          height: 360,
          background_color: '#000000',
          output_format: 'mp4',
          output_target_path: '/tmp/outside-video.mp4',
          bundle_dir: 'active/shared/tmp/video-composition/outside',
          index_html: 'active/shared/tmp/video-composition/outside/index.html',
          scenes: [],
          artifact_refs: [],
        },
        {
          version: '1.0.0',
          queue: { concurrency: 1, cancellation: 'queued_or_running' },
          progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
          bundle: {
            default_bundle_root: 'active/shared/tmp/video-composition',
            copy_declared_assets: false,
          },
          render: {
            allowed_output_formats: ['mp4'],
            enable_backend_rendering: true,
            backend: 'hyperframes_cli',
            quality: 'standard',
            command_timeout_ms: 300000,
          },
        }
      )
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('invokes hyperframes CLI when backend rendering is enabled', async () => {
    const { renderVideoCompositionBundle } = await import('./video-render-backend.js');
    const result = await renderVideoCompositionBundle(
      {
        kind: 'video-composition-render-plan',
        version: '1.0.0',
        composition_id: 'demo',
        source_kind: 'video-composition-adf',
        title: 'Demo',
        duration_sec: 3,
        fps: 30,
        width: 1920,
        height: 1080,
        background_color: '#000000',
        output_format: 'mp4',
        narration_ref: NARRATION_PATH,
        output_target_path: 'active/shared/tmp/video-composition/demo/output.mp4',
        bundle_dir: VIDEO_BUNDLE_DIR,
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: {
          default_bundle_root: 'active/shared/tmp/video-composition',
          copy_declared_assets: false,
        },
        render: {
          allowed_output_formats: ['mp4'],
          enable_backend_rendering: true,
          backend: 'hyperframes_cli',
          quality: 'standard',
          command_timeout_ms: 300000,
        },
      }
    );
    expect(result.executed).toBe(true);
    expect(result.backend).toBe('hyperframes_cli');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['hyperframes', 'render', VIDEO_BUNDLE_DIR, '--format', 'mp4']),
      expect.objectContaining({ timeoutMs: 300000 })
    );
    expect(corePlatform.runMediaCommand).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-i',
        pathResolver.resolve('active/shared/tmp/video-composition/demo/output.mp4'),
        '-i',
        NARRATION_PATH,
      ])
    );
    expect(mocks.safeMoveSync).toHaveBeenCalled();
  });

  it('muxes music tracks when no narration track is present', async () => {
    const { renderVideoCompositionBundle } = await import('./video-render-backend.js');
    const result = await renderVideoCompositionBundle(
      {
        kind: 'video-composition-render-plan',
        version: '1.0.0',
        composition_id: 'music-demo',
        source_kind: 'video-composition-adf',
        title: 'Music Demo',
        duration_sec: 8,
        fps: 30,
        width: 1920,
        height: 1080,
        background_color: '#000000',
        output_format: 'mp4',
        music_ref: MUSIC_PATH,
        output_target_path: 'active/shared/tmp/video-composition/demo/music-output.mp4',
        bundle_dir: VIDEO_BUNDLE_DIR,
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: {
          default_bundle_root: 'active/shared/tmp/video-composition',
          copy_declared_assets: false,
        },
        render: {
          allowed_output_formats: ['mp4'],
          enable_backend_rendering: true,
          backend: 'hyperframes_cli',
          quality: 'standard',
          command_timeout_ms: 300000,
        },
      }
    );

    expect(result.executed).toBe(true);
    expect(corePlatform.runMediaCommand).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-i',
        pathResolver.resolve('active/shared/tmp/video-composition/demo/music-output.mp4'),
        '-i',
        MUSIC_PATH,
      ])
    );
  });

  it('falls back to a title-card mp4 when hyperframes fails', async () => {
    mocks.safeExec.mockImplementation((command: string) => {
      if (command === 'npx') {
        throw new Error('hyperframes failed');
      }
      if (command === 'ffprobe') {
        return '0\n';
      }
      return '';
    });

    const { renderVideoCompositionBundle } = await import('./video-render-backend.js');
    const result = await renderVideoCompositionBundle(
      {
        kind: 'video-composition-render-plan',
        version: '1.0.0',
        composition_id: 'fallback-demo',
        source_kind: 'video-composition-adf',
        title: 'Fallback Demo',
        duration_sec: 4,
        fps: 30,
        width: 1920,
        height: 1080,
        background_color: '#07111f',
        output_format: 'mp4',
        narration_ref: NARRATION_PATH,
        output_target_path: 'active/shared/tmp/video-composition/demo/fallback-output.mp4',
        bundle_dir: VIDEO_BUNDLE_DIR,
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: {
          default_bundle_root: 'active/shared/tmp/video-composition',
          copy_declared_assets: false,
        },
        render: {
          allowed_output_formats: ['mp4'],
          enable_backend_rendering: true,
          backend: 'hyperframes_cli',
          quality: 'standard',
          command_timeout_ms: 300000,
        },
      }
    );

    expect(result.executed).toBe(true);
    expect(result.backend).toBe('ffmpeg_fallback');
    // MP-02: the fallback produces a file, so `executed` alone reads as
    // success. The degradation must be explicit or a still-image slideshow
    // ships as if it were the requested render.
    expect(result.degraded).toBe(true);
    expect(result.degraded_from).toBe('hyperframes_cli');
    expect(result.degradation_reason).toContain('slideshow');
    expect(result.degradation_reason).toContain('hyperframes');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining([expect.stringContaining('scripts/make_video_cover.py')]),
      expect.objectContaining({ timeoutMs: 30000 })
    );
    expect(mocks.safeExec.mock.calls.some(([command]) => command === 'ffmpeg')).toBe(true);
  });
});
