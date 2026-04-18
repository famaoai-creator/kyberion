import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compileSchemaFromPath: vi.fn(() => {
    const validator: any = () => true;
    validator.errors = [];
    return validator;
  }),
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
  safeReadFile: vi.fn(),
  writeVideoCompositionBundle: vi.fn(() => ({
    artifact_refs: [
      '/tmp/video-composition/index.html',
      '/tmp/video-composition/render-plan.json',
    ],
  })),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    compileSchemaFromPath: mocks.compileSchemaFromPath,
    getVideoCompositionTemplateRegistry: mocks.getVideoCompositionTemplateRegistry,
    safeReadFile: mocks.safeReadFile,
    writeVideoCompositionBundle: mocks.writeVideoCompositionBundle,
  };
});

describe('video-composition-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists governed templates', async () => {
    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'list_video_composition_templates',
      params: {},
    } as any);

    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      default_template_id: 'basic-title-card',
    }));
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
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      output_format: 'mp4',
      artifact_refs: ['/tmp/video-composition/index.html', '/tmp/video-composition/render-plan.json'],
      backend_rendering_enabled: false,
    }));
  });
});
