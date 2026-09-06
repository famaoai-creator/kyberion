import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import videoCompositionJobTicketSchema from '../../../../knowledge/product/schemas/video-composition-job-ticket.schema.json';

const mocks = vi.hoisted(() => ({
  compileSchemaFromPath: vi.fn(() => {
    const validator: any = () => true;
    validator.errors = [];
    return validator;
  }),
  safeExec: vi.fn(() => '1'),
  safeExecResult: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
  safeExistsSync: vi.fn(() => true),
  safeStat: vi.fn(() => ({ size: 4096 })),
  // governed-catalog's `.load()` calls the real `safeLstat` (imported
  // straight from secure-io.js, not routed through FoundationIo) once
  // `exists()` reports true. The manifest/job fixtures here are faked
  // through `safeExistsSync`/FoundationIo rather than written to real disk
  // under the mocked `/tmp/...` roots, so the real lstat would ENOENT —
  // fake it to match `safeExistsSync`.
  safeLstat: vi.fn(() => ({ isFile: () => true, isSymbolicLink: () => false })),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
  assertSafeRepositoryPath: vi.fn((candidate: string) => {
    const normalized = path.resolve(String(candidate));
    const metricsPath = path.resolve('work/metrics');
    if (normalized !== '/tmp' && !normalized.startsWith('/tmp/') && normalized !== metricsPath) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${candidate}`
      );
    }
    return normalized;
  }),
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getVideoCompositionTemplateRegistry: vi.fn(() => ({
    version: 'test',
    default_template_id: 'basic-title-card',
    templates: [
      {
        template_id: 'basic-title-card',
        display_name: 'Basic Title Card',
        status: 'active',
        renderer: 'builtin_html',
        supported_roles: ['hook', 'generic', 'cta'],
        required_content_fields: ['headline'],
        supported_output_formats: ['mp4'],
      },
    ],
  })),
  getVideoRenderRuntimePolicy: vi.fn(() => ({
    version: 'test',
    queue: { concurrency: 1, cancellation: 'queued_or_running' },
    progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
  })),
  safeReadFile: vi.fn(),
  compileNarratedVideoBriefToCompositionADF: vi.fn(() => ({
    kind: 'video-composition-adf',
    version: '1.0.0',
    composition: { duration_sec: 9, fps: 30, width: 1920, height: 1080 },
    scenes: [],
    output: { format: 'mp4', await_completion: true },
  })),
  compileVideoCompositionADF: vi.fn(() => ({
    kind: 'video-composition-render-plan',
    version: '1.0.0',
    composition_id: 'demo',
    source_kind: 'video-composition-adf',
    title: 'Kyberion',
    duration_sec: 9,
    fps: 30,
    width: 1920,
    height: 1080,
    background_color: '#07111f',
    output_format: 'mp4',
    bundle_dir: '/tmp/video-composition',
    index_html: '/tmp/video-composition/index.html',
    scenes: [
      {
        scene_id: 'hook',
        role: 'hook',
        start_sec: 0,
        duration_sec: 3,
        template_id: 'basic-title-card',
        template_display_name: 'Basic Title Card',
        output_html: 'compositions/hook.html',
        required_content_fields: ['headline'],
        content: { headline: 'Intent to Execution' },
        asset_refs: [],
      },
      {
        scene_id: 'feature',
        role: 'feature',
        start_sec: 3,
        duration_sec: 3,
        template_id: 'promo-spot',
        template_display_name: 'Promo Spot',
        output_html: 'compositions/feature.html',
        required_content_fields: ['headline'],
        content: { headline: 'Structure first' },
        asset_refs: [],
      },
      {
        scene_id: 'cta',
        role: 'cta',
        start_sec: 6,
        duration_sec: 3,
        template_id: 'logo-outro',
        template_display_name: 'Logo Outro',
        output_html: 'compositions/cta.html',
        required_content_fields: ['headline'],
        content: { headline: 'Ship it' },
        asset_refs: [],
      },
    ],
    artifact_refs: [],
  })),
  compileVideoContentBriefToStoryboard: vi.fn(() => ({
    kind: 'video-storyboard',
    version: '1.0.0',
    format: { width: 1920, height: 1080 },
    beats: [],
  })),
  compileVideoStoryboardToNarratedVideoBrief: vi.fn(() => ({
    kind: 'narrated-video-brief',
    version: '1.0.0',
    script: { hook: 'hook', feature: 'feature', cta: 'cta' },
    narration: { artifact_ref: 'active/shared/exports/narration.aiff' },
    design_system: { brand_name: 'Kyberion' },
  })),
  renderNarratedFallbackVideo: vi.fn(async () => ({
    executed: true,
    backend: 'ffmpeg_fallback',
    output_path: '/tmp/video-composition/output.mp4',
  })),
  renderVideoCompositionBundleAsync: vi.fn(async () => ({
    executed: true,
    backend: 'hyperframes_cli',
    output_path: '/tmp/video-composition/output.mp4',
    artifact_refs: [
      '/tmp/video-composition/index.html',
      '/tmp/video-composition/render-plan.json',
      '/tmp/video-composition/output.mp4',
    ],
  })),
  writeVideoCompositionBundle: vi.fn(() => ({
    bundle_dir: '/tmp/video-composition',
    artifact_refs: ['/tmp/video-composition/index.html', '/tmp/video-composition/render-plan.json'],
  })),
}));

vi.mock('@agent/core/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/foundation')>()),
  compileSchema: mocks.compileSchemaFromPath,
  getRegisteredEnvText: (name: string) => process.env[name],
  nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExec: mocks.safeExec,
  safeExecResult: mocks.safeExecResult,
  safeExistsSync: mocks.safeExistsSync,
  safeStat: mocks.safeStat,
  safeLstat: mocks.safeLstat,
  safeMkdir: mocks.safeMkdir,
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
}));
vi.mock('@agent/core/async-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/async-utils')>()),
  retry: mocks.retry,
}));
vi.mock('@agent/core/path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/path-resolver')>()),
  pathResolver: {
    rootDir: vi.fn(() => '/tmp'),
    rootResolve: vi.fn((p: string) => `/tmp/${String(p).replace(/^\/+/, '')}`),
    shared: vi.fn((p = '') => `/tmp/${String(p).replace(/^\/+/, '')}`),
    sharedTmp: vi.fn((p = '') => `/tmp/${String(p).replace(/^\/+/, '')}`),
    knowledge: vi.fn((p = '') => `/tmp/${String(p).replace(/^\/+/, '')}`),
    active: vi.fn((p = '') => `/tmp/active/${String(p).replace(/^\/+/, '')}`),
    vault: vi.fn((p = '') => `/tmp/.vault/${String(p).replace(/^\/+/, '')}`),
    resolve: vi.fn((p = '') => (String(p).startsWith('/') ? String(p) : `/tmp/${p}`)),
    toRepoRelative: vi.fn((p = '') => String(p).replace(/^\/tmp\//, '')),
  },
}));
vi.mock('@agent/core/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/core')>()),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@agent/core/video-composition-compiler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/video-composition-compiler')>()),
  compileVideoCompositionADF: mocks.compileVideoCompositionADF,
  writeVideoCompositionBundle: mocks.writeVideoCompositionBundle,
}));
vi.mock('@agent/core/narrated-video-brief-compiler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/narrated-video-brief-compiler')>()),
  compileNarratedVideoBriefToCompositionADF: mocks.compileNarratedVideoBriefToCompositionADF,
}));
vi.mock('@agent/core/video-content-brief-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/video-content-brief-contract')>()),
  compileVideoContentBriefToStoryboard: mocks.compileVideoContentBriefToStoryboard,
  compileVideoStoryboardToNarratedVideoBrief: mocks.compileVideoStoryboardToNarratedVideoBrief,
}));
vi.mock('@agent/core/video-composition-template-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/video-composition-template-registry')>()),
  getVideoCompositionTemplateRegistry: mocks.getVideoCompositionTemplateRegistry,
}));
vi.mock('@agent/core/video-render-runtime-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/video-render-runtime-policy')>()),
  getVideoRenderRuntimePolicy: mocks.getVideoRenderRuntimePolicy,
}));
vi.mock('@agent/core/video-render-backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/video-render-backend')>()),
  renderNarratedFallbackVideo: mocks.renderNarratedFallbackVideo,
  renderVideoCompositionBundleAsync: mocks.renderVideoCompositionBundleAsync,
}));

async function installMockFoundationIo(): Promise<void> {
  const foundation = await import('@agent/core/foundation');
  const nodeFs = await import('node:fs');
  const actualPathResolver = await vi.importActual<typeof import('@agent/core/path-resolver')>(
    '@agent/core/path-resolver'
  );
  const resolveActualPath = (filePath: string): string => {
    const normalizedPath = String(filePath).replaceAll('\\', '/');
    const schemaMarker = '/product/schemas/';
    if (normalizedPath.includes(schemaMarker)) {
      return actualPathResolver.pathResolver.rootResolve(
        `knowledge/product/schemas/${normalizedPath.split(schemaMarker)[1]}`
      );
    }
    return filePath;
  };
  const readFile = (filePath: string): string => {
    const normalizedPath = String(filePath).replaceAll('\\', '/');
    // `governed-catalog.ts` imports `compileSchema` straight from
    // `./ajv.js`, not through the `@agent/core/foundation` barrel, so
    // mocking that barrel's `compileSchema` export (above) never reaches it
    // — real schema compilation (and thus a real schema read) still runs.
    // This file also mocks `@agent/core/path-resolver`'s `rootDir` to
    // `/tmp`, which would make secure-io's own tier-guard reject a real
    // absolute repo path as "outside project root". Read the real schema
    // straight off disk to sidestep that self-inflicted guard mismatch.
    return normalizedPath.includes('/product/schemas/')
      ? nodeFs.readFileSync(resolveActualPath(filePath), 'utf8')
      : String(mocks.safeReadFile(filePath));
  };
  foundation.registerFoundationIo({
    loadJson: <T>(filePath: string): T => {
      if (String(filePath).endsWith('/video-composition-job-ticket.schema.json')) {
        return videoCompositionJobTicketSchema as T;
      }
      return JSON.parse(readFile(filePath)) as T;
    },
    loadJsonIfPresent: <T>(filePath: string): T | null => {
      try {
        return JSON.parse(readFile(filePath)) as T;
      } catch {
        return null;
      }
    },
    appendFile: vi.fn(),
    exists: (filePath: string): boolean =>
      String(filePath).replaceAll('\\', '/').includes('/product/schemas/')
        ? true
        : mocks.safeExistsSync(filePath),
    readFile,
    stat: (filePath: string) => ({
      mtimeMs: 0,
      size: String(readFile(filePath)).length,
    }),
    writeFile: (filePath: string, content: string): void => {
      mocks.safeWriteFile(filePath, content);
    },
  });
}

describe('video-composition-actuator', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { safeReadFile } = await import('@agent/core/secure-io');
    vi.mocked(safeReadFile).mockImplementation((filePath: string) => {
      if (String(filePath).includes('manifest.json')) {
        return JSON.stringify({
          actuator_id: 'video-composition-actuator',
          version: '0.0.0-test',
          capabilities: [],
          recovery_policy: {},
        });
      }
      return '{}';
    });
    vi.mocked(mocks.safeExistsSync).mockImplementation(() => true);
    vi.mocked(mocks.safeWriteFile).mockImplementation(() => undefined);
    vi.mocked(mocks.safeMkdir).mockImplementation(() => undefined);
    await installMockFoundationIo();
    vi.mocked(mocks.safeExec).mockImplementation((command: string, args: any[]) => {
      if (command === 'ffprobe' && Array.isArray(args) && args.includes('a:0')) {
        return '0';
      }
      if (command === 'ffprobe' && Array.isArray(args) && args.includes('v:0')) {
        return '1';
      }
      return '1';
    });
  });

  it('lists governed templates', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'list_video_composition_templates',
      params: {},
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        default_template_id: 'basic-title-card',
      })
    );
  });

  it('compiles narrated video brief into composition adf', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'compile_narrated_video_brief',
      params: {
        narrated_video_brief: {
          kind: 'narrated-video-brief',
          version: '1.0.0',
        },
      },
    } as any);

    expect(mocks.compileNarratedVideoBriefToCompositionADF).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        kind: 'compiled_video_composition_adf',
      })
    );
    expect(result.video_composition_adf.kind).toBe('video-composition-adf');
  });

  it('creates narrated intro movie in a single action', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'create_narrated_intro_movie',
      params: {
        narrated_video_brief: {
          kind: 'narrated-video-brief',
          version: '1.0.0',
          script: {
            hook: 'Intent to Execution',
            feature: 'Contracts connect planning and execution.',
            cta: 'Operate with Kyberion.',
          },
          narration: {
            artifact_ref: 'active/shared/exports/narration.aiff',
          },
          design_system: {
            brand_name: 'Kyberion',
          },
        },
      },
    } as any);

    expect(mocks.compileNarratedVideoBriefToCompositionADF).toHaveBeenCalled();
    expect(mocks.writeVideoCompositionBundle).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'narrated_intro_movie_run',
      })
    );
    expect(result.execution).toEqual(
      expect.objectContaining({
        status: 'succeeded',
      })
    );
  });

  it('compiles video content brief into storyboard', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'compile_video_content_brief',
      params: {
        video_content_brief: {
          kind: 'video-content-brief',
          version: '1.0.0',
          audience: 'operators',
          objective: 'turn approved messaging into content',
          distribution_channel: 'docs-demo',
          content_type: 'howto',
          presentation_mode: 'howto',
          promise: 'clear process',
          desired_takeaway: 'content brief becomes a renderable plan',
          constraints: ['no pitch'],
          proof_points: ['brief', 'storyboard', 'render'],
          design_system_ref: {
            system_id: 'operator-ops',
            brand_name: 'Kyberion',
          },
        },
      },
    } as any);

    expect(mocks.compileVideoContentBriefToStoryboard).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        kind: 'compiled_video_storyboard',
      })
    );
  });

  it('creates narrated movie from video content brief', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'create_narrated_video_from_content_brief',
      params: {
        video_content_brief: {
          kind: 'video-content-brief',
          version: '1.0.0',
          audience: 'operators',
          objective: 'turn approved messaging into content',
          distribution_channel: 'docs-demo',
          content_type: 'howto',
          presentation_mode: 'howto',
          promise: 'clear process',
          desired_takeaway: 'content brief becomes a renderable plan',
          constraints: ['no pitch'],
          proof_points: ['brief', 'storyboard', 'render'],
          design_system_ref: {
            system_id: 'operator-ops',
            brand_name: 'Kyberion',
            background_color: '#07111f',
          },
        },
        narration_artifact_ref: 'active/shared/exports/narration.aiff',
        output: {
          format: 'mp4',
          target_path: '/tmp/content-brief-movie.mp4',
          await_completion: true,
        },
      },
    } as any);

    expect(mocks.compileVideoContentBriefToStoryboard).toHaveBeenCalled();
    expect(mocks.compileVideoStoryboardToNarratedVideoBrief).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'narrated_content_brief_movie_run',
      })
    );
    expect(result.execution).toEqual(
      expect.objectContaining({
        status: 'succeeded',
      })
    );
  });

  it('repairs invalid rendered output with fallback video', async () => {
    vi.mocked(mocks.getVideoRenderRuntimePolicy).mockImplementation(() => ({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
    }));
    vi.mocked(mocks.safeExec).mockImplementation((command: string) => {
      if (command === 'ffprobe') {
        return '';
      }
      return '1';
    });
    vi.mocked(mocks.safeStat).mockReturnValue({ size: 128 } as any);

    try {
      const { handleAction } = await import('./index.js');
      const result = await handleAction({
        action: 'create_narrated_intro_movie',
        params: {
          narrated_video_brief: {
            kind: 'narrated-video-brief',
            version: '1.0.0',
            script: {
              hook: 'Intent to Execution',
              feature: 'Contracts connect planning and execution.',
              cta: 'Operate with Kyberion.',
            },
            narration: {
              artifact_ref: 'active/shared/exports/narration.aiff',
            },
            design_system: {
              brand_name: 'Kyberion',
            },
          },
        },
      } as any);

      expect(mocks.renderNarratedFallbackVideo).toHaveBeenCalled();
      expect(mocks.compileVideoCompositionADF).toHaveBeenCalled();
      expect(result.execution).toEqual(
        expect.objectContaining({
          status: 'succeeded',
        })
      );
    } finally {
      vi.mocked(mocks.getVideoRenderRuntimePolicy).mockImplementation(() => ({
        version: 'test',
        queue: { concurrency: 1, cancellation: 'queued_or_running' },
        progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
      }));
      vi.mocked(mocks.safeExec).mockImplementation((command: string, args: any[]) => {
        if (command === 'ffprobe' && Array.isArray(args) && args.includes('a:0')) {
          return '0';
        }
        if (command === 'ffprobe' && Array.isArray(args) && args.includes('v:0')) {
          return '1';
        }
        return '1';
      });
      vi.mocked(mocks.safeStat).mockReturnValue({ size: 4096 } as any);
    }
  });

  it('verifies rendered video artifacts with audio and video streams', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'verify_rendered_video_artifact',
      params: {
        path: '/tmp/content-brief-movie.mp4',
        require_audio: true,
        require_video: true,
      },
    } as any);

    expect(mocks.safeExec).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining(['-select_streams', 'a:0']),
      expect.objectContaining({ timeoutMs: 30000 })
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        kind: 'video_artifact_verification',
        has_audio: true,
        has_video: true,
      })
    );
  });

  it('rejects video artifact paths outside the repository', async () => {
    const { handleAction } = await import('./index.js');
    await expect(
      handleAction({
        action: 'verify_rendered_video_artifact',
        params: { path: '../../external-video.mp4' },
      } as any)
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('validates narrated video artifacts through the typed actuator contract', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'validate_narrated_video_artifact',
      params: {
        narration_path: 'active/shared/tmp/narration.aiff',
        video_output_path: 'active/shared/tmp/render.mp4',
        video_bundle_dir: 'active/shared/tmp/render-bundle',
        mission_evidence_dir: 'active/shared/tmp/evidence',
        video_slug: 'demo',
      },
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        kind: 'narrated_video_artifact_validation',
        black_frame_check: 'passed',
        duration_delta_sec: 0,
      })
    );
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['blackdetect=d=0.5:pic_th=0.98:pix_th=0.10']),
      expect.objectContaining({ timeoutMs: 120000 })
    );
  });

  it('prepares a composed-video bundle from an adf', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'Hello deterministic video' },
            },
          ],
          output: {
            format: 'mp4',
          },
        },
      },
    } as any);

    expect(mocks.writeVideoCompositionBundle).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        output_format: 'mp4',
        artifact_refs: [
          '/tmp/video-composition/index.html',
          '/tmp/video-composition/render-plan.json',
        ],
        backend_rendering_enabled: false,
      })
    );
    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        terminal_status: 'completed',
      })
    );
    expect(typeof result.diagnostics.created_at).toBe('string');
    expect(typeof result.diagnostics.started_at).toBe('string');
    expect(typeof result.diagnostics.finished_at).toBe('string');
    expect(typeof result.diagnostics.duration_ms).toBe('number');
  });

  it('runs backend rendering when policy enables it', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'Render this scene' },
            },
          ],
          output: {
            format: 'mp4',
            target_path: '/tmp/video-composition/output.mp4',
            await_completion: true,
          },
        },
      },
    } as any);

    expect(mocks.renderVideoCompositionBundleAsync).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        backend_rendering_enabled: true,
        backend_render_backend: 'hyperframes_cli',
        backend_rendered: true,
      })
    );
    expect(result.artifact_refs).toContain('/tmp/video-composition/output.mp4');
  });

  it('supports async enqueue and status/queue inspection', async () => {
    const { handleAction } = await import('./index.js');
    const queued = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'queue me' },
            },
          ],
          output: {
            format: 'mp4',
            await_completion: false,
          },
        },
      },
    } as any);

    expect(queued).toEqual(
      expect.objectContaining({
        status: 'queued',
        await_completion: false,
        output_format: 'mp4',
        job_ticket_path: expect.stringContaining('/tmp/video-composition/job-state.json'),
      })
    );
    expect(typeof queued.job_id).toBe('string');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/video-composition/job-state.json'),
      expect.stringContaining(`"job_id": "${queued.job_id}"`)
    );

    const queue = await handleAction({
      action: 'get_video_composition_queue',
      params: {},
    } as any);
    expect(queue).toEqual(
      expect.objectContaining({
        status: 'succeeded',
      })
    );
    expect(queue.queue).toEqual(
      expect.objectContaining({
        concurrency: 1,
      })
    );

    const status = await handleAction({
      action: 'get_video_composition_job_status',
      params: { job_id: queued.job_id },
    } as any);
    expect(status).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        job_id: queued.job_id,
      })
    );
    expect(status.packet).toEqual(
      expect.objectContaining({
        job_id: queued.job_id,
      })
    );
  });

  it('defaults to queued when backend rendering is enabled and await_completion is omitted', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'queue by default' },
            },
          ],
          output: {
            format: 'mp4',
          },
        },
      },
    } as any);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'queued',
        await_completion: false,
        backend_rendering_enabled: true,
        backend_render_backend: 'hyperframes_cli',
      })
    );
    expect(String(result.await_completion_reason)).toContain('default asynchronous mode');
  });

  it('returns not_found when cancelling unknown job', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'cancel_video_composition_job',
      params: { job_id: 'missing-job' },
    } as any);

    expect(result).toEqual({
      status: 'not_found',
      job_id: 'missing-job',
      cancellation: null,
      packet: null,
      diagnostics: null,
    });
  });

  it('returns timeout for await action when job does not finish in time', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
    });
    let releaseRender!: () => void;
    const renderReleased = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    mocks.renderVideoCompositionBundleAsync.mockImplementationOnce(async () => {
      await renderReleased;
      return {
        executed: true,
        backend: 'hyperframes_cli',
        output_path: '/tmp/video-composition/output.mp4',
      };
    });

    const { handleAction } = await import('./index.js');
    const queued = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'await timeout' },
            },
          ],
          output: {
            format: 'mp4',
            await_completion: false,
          },
        },
      },
    } as any);

    const awaited = await handleAction({
      action: 'await_video_composition_job',
      params: {
        job_id: queued.job_id,
        timeout_ms: 20,
      },
    } as any);

    expect(awaited).toEqual(
      expect.objectContaining({
        status: 'timeout',
        job_id: queued.job_id,
      })
    );
    releaseRender();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('cancels a running backend render job', async () => {
    mocks.getVideoRenderRuntimePolicy.mockReturnValue({
      version: 'test',
      queue: { concurrency: 1, cancellation: 'queued_or_running' },
      progress: { throttle_ms: 0, min_percent_delta: 0, emit_heartbeat: true },
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
    });
    let releaseRender!: () => void;
    const renderReleased = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let renderStarted!: () => void;
    const renderStartedPromise = new Promise<void>((resolve) => {
      renderStarted = resolve;
    });
    mocks.renderVideoCompositionBundleAsync.mockImplementationOnce(
      async (_plan: any, _policy: any, options: any) => {
        renderStarted();
        await renderReleased;
        if (options?.isCancelled?.()) {
          const error: any = new Error('video render cancelled');
          error.cancelled = true;
          error.timed_out = false;
          error.signal = 'SIGTERM';
          error.exit_code = null;
          throw error;
        }
        return {
          executed: true,
          backend: 'hyperframes_cli',
          output_path: '/tmp/video-composition/output.mp4',
        };
      }
    );

    const { handleAction } = await import('./index.js');
    const queued = await handleAction({
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          kind: 'video-composition-adf',
          version: '1.0.0',
          composition: {
            duration_sec: 3,
            fps: 30,
            width: 1920,
            height: 1080,
          },
          scenes: [
            {
              scene_id: 'hook',
              start_sec: 0,
              duration_sec: 3,
              template_ref: { template_id: 'basic-title-card' },
              content: { headline: 'cancel me' },
            },
          ],
          output: {
            format: 'mp4',
            await_completion: false,
          },
        },
      },
    } as any);

    await renderStartedPromise;
    const cancelPromise = handleAction({
      action: 'cancel_video_composition_job',
      params: { job_id: queued.job_id, reason: 'operator-requested stop' },
    } as any);
    releaseRender();
    const cancelled = await cancelPromise;
    expect(cancelled).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        cancellation: 'running',
        job_id: queued.job_id,
      })
    );
    expect(cancelled.diagnostics).toEqual(
      expect.objectContaining({
        cancellation_reason: 'operator-requested stop',
      })
    );
    const status = await waitForCancelledStatusWithSignal(handleAction, queued.job_id);
    expect(status.packet.status).toBe('cancelled');
    expect(status.packet.message).toContain('operator-requested stop');
    expect(status.diagnostics).toEqual(
      expect.objectContaining({
        terminal_status: 'cancelled',
        cancellation_reason: 'operator-requested stop',
        backend_exit_signal: 'SIGTERM',
        backend_cancelled: true,
      })
    );
    expect(typeof status.diagnostics.duration_ms).toBe('number');
  });

  // MP-02: the lint gate. A bundle that reads a clock cannot be reproduced,
  // so the step fails rather than rendering something untestable.
  describe('lint_video_composition', () => {
    const compositionAdf = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      composition: { duration_sec: 3, fps: 30, width: 1920, height: 1080 },
      scenes: [
        {
          scene_id: 'hook',
          role: 'hook',
          start_sec: 0,
          duration_sec: 3,
          template_ref: { template_id: 'basic-title-card' },
          content: {},
        },
      ],
      output: { format: 'mp4', bundle_dir: 'active/shared/tmp/lint-bundle' },
    };

    it('passes a deterministic bundle', async () => {
      const { safeReadFile } = await import('@agent/core/secure-io');
      vi.mocked(safeReadFile).mockImplementation((filePath: string) => {
        if (String(filePath).includes('manifest.json'))
          return JSON.stringify({
            actuator_id: 'video-composition-actuator',
            version: '0.0.0-test',
            capabilities: [],
            recovery_policy: {},
          });
        if (String(filePath).endsWith('hook.html')) {
          return '<style>.a { animation: kb-in-fade-rise 0.8s ease both; }</style>';
        }
        return '{}';
      });

      const { handleAction } = await import('./index.js');
      const result: any = await handleAction({
        action: 'lint_video_composition',
        params: { video_composition_adf: compositionAdf },
      } as any);

      expect(result.status).toBe('succeeded');
      expect(result.lint_report.ok).toBe(true);
      expect(result.scenes_inspected).toBe(1);
    });

    it('fails the step when scene HTML is non-deterministic', async () => {
      const { safeReadFile } = await import('@agent/core/secure-io');
      vi.mocked(safeReadFile).mockImplementation((filePath: string) => {
        if (String(filePath).includes('manifest.json'))
          return JSON.stringify({
            actuator_id: 'video-composition-actuator',
            version: '0.0.0-test',
            capabilities: [],
            recovery_policy: {},
          });
        if (String(filePath).endsWith('hook.html')) {
          return '<script>const seed = Math.random();</script>';
        }
        return '{}';
      });

      const { handleAction } = await import('./index.js');
      await expect(
        handleAction({
          action: 'lint_video_composition',
          params: { video_composition_adf: compositionAdf },
        } as any)
      ).rejects.toThrow(/lint failed/i);
    });

    it('reports without failing when fail_on_error is false', async () => {
      const { safeReadFile } = await import('@agent/core/secure-io');
      vi.mocked(safeReadFile).mockImplementation((filePath: string) => {
        if (String(filePath).includes('manifest.json'))
          return JSON.stringify({
            actuator_id: 'video-composition-actuator',
            version: '0.0.0-test',
            capabilities: [],
            recovery_policy: {},
          });
        if (String(filePath).endsWith('hook.html')) {
          return '<script>const t = Date.now();</script>';
        }
        return '{}';
      });

      const { handleAction } = await import('./index.js');
      const result: any = await handleAction({
        action: 'lint_video_composition',
        params: { video_composition_adf: compositionAdf, fail_on_error: false },
      } as any);

      expect(result.status).toBe('succeeded');
      expect(result.lint_report.ok).toBe(false);
      expect(result.lint_report.error_count).toBeGreaterThan(0);
    });

    it('requires the composition contract', async () => {
      const { handleAction } = await import('./index.js');
      await expect(
        handleAction({ action: 'lint_video_composition', params: {} } as any)
      ).rejects.toThrow(/requires params.video_composition_adf/);
    });
  });
});

async function waitForCancelledStatusWithSignal(handleAction: any, jobId: string) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const status = await handleAction({
      action: 'get_video_composition_job_status',
      params: { job_id: jobId },
    } as any);
    if (status?.packet?.status === 'cancelled' && status?.diagnostics?.backend_exit_signal)
      return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for cancelled packet with signal: ${jobId}`);
}
