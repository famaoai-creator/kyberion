import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pathResolver, platform as corePlatform } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => ''),
  safeExistsSync: vi.fn(() => true),
  safeMoveSync: vi.fn(),
  safeRmSync: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual('./secure-io.js') as any;
  return {
    ...actual,
    safeExec: mocks.safeExec,
    safeExistsSync: mocks.safeExistsSync,
    safeMoveSync: mocks.safeMoveSync,
    safeRmSync: mocks.safeRmSync,
  };
});

describe('video render backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(corePlatform, 'getCapabilities').mockResolvedValue({ hasFFmpeg: true } as any);
    vi.spyOn(corePlatform, 'runMediaCommand').mockResolvedValue('');
    mocks.safeExec.mockImplementation(() => '');
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
        bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
        render: { allowed_output_formats: ['mp4'], enable_backend_rendering: false, backend: 'none', quality: 'standard', command_timeout_ms: 300000 },
      },
    );
    expect(result.executed).toBe(false);
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
        narration_ref: '/tmp/demo/narration.aiff',
        output_target_path: 'active/shared/tmp/video-composition/demo/output.mp4',
        bundle_dir: '/tmp/demo',
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
        render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
      },
    );
    expect(result.executed).toBe(true);
    expect(result.backend).toBe('hyperframes_cli');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining(['hyperframes', 'render', '/tmp/demo', '--format', 'mp4']),
      expect.objectContaining({ timeoutMs: 300000 }),
    );
    expect(corePlatform.runMediaCommand).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-i',
        pathResolver.resolve('active/shared/tmp/video-composition/demo/output.mp4'),
        '-i',
        '/tmp/demo/narration.aiff',
      ]),
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
        music_ref: '/tmp/demo/music.mp3',
        output_target_path: 'active/shared/tmp/video-composition/demo/music-output.mp4',
        bundle_dir: '/tmp/demo',
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
        render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
      },
    );

    expect(result.executed).toBe(true);
    expect(corePlatform.runMediaCommand).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-i',
        pathResolver.resolve('active/shared/tmp/video-composition/demo/music-output.mp4'),
        '-i',
        '/tmp/demo/music.mp3',
      ]),
    );
  });

  it('falls back to a title-card mp4 when hyperframes fails', async () => {
    mocks.safeExec.mockImplementation((command: string) => {
      if (command === 'npx') {
        throw new Error('hyperframes failed');
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
        narration_ref: '/tmp/demo/narration.aiff',
        output_target_path: 'active/shared/tmp/video-composition/demo/fallback-output.mp4',
        bundle_dir: '/tmp/demo',
        index_html: '/tmp/demo/index.html',
        scenes: [],
        artifact_refs: [],
      },
      {
        version: '1.0.0',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 250, min_percent_delta: 2, emit_heartbeat: true },
        bundle: { default_bundle_root: 'active/shared/tmp/video-composition', copy_declared_assets: false },
        render: { allowed_output_formats: ['mp4'], enable_backend_rendering: true, backend: 'hyperframes_cli', quality: 'standard', command_timeout_ms: 300000 },
      },
    );

    expect(result.executed).toBe(true);
    expect(result.backend).toBe('ffmpeg_fallback');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining([expect.stringContaining('scripts/make_video_cover.py')]),
      expect.objectContaining({ timeoutMs: 30000 }),
    );
    expect(mocks.safeExec.mock.calls.some(([command]) => command === 'ffmpeg')).toBe(true);
  });
});
