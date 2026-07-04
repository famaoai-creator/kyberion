import path from 'node:path';
import AjvModule from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  compileVideoContentBriefToStoryboard,
  compileVideoStoryboardToNarratedVideoBrief,
} from './video-content-brief-contract.js';
import {
  resolveDefaultVideoBackgroundColor,
  resolveVideoModeDefaults,
} from './video-design-system.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('video content brief contract', () => {
  const tenantRoot = pathResolver.shared('tmp/video-tenant-fixture');
  const tenantFixtureRoot = path.join(tenantRoot, 'knowledge/confidential/video-tenant-fixture');

  afterEach(() => {
    safeRmSync(tenantRoot, { recursive: true, force: true });
  });

  it('compiles a how-to brief into a storyboard and narrated brief', () => {
    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      title: 'Kyberion how-to',
      audience: 'operators',
      objective: 'turn a brief into a video',
      distribution_channel: 'docs-demo',
      content_type: 'howto',
      presentation_mode: 'howto',
      promise: 'clear governed output',
      desired_takeaway: 'content brief becomes renderable',
      constraints: ['no pitch'],
      proof_points: ['brief', 'storyboard', 'render'],
      content_requirements: ['show intake', 'show plan', 'show render'],
      fixed_inputs: {
        customer: 'operators',
        use_case: 'governed work',
        message: 'brief to video',
      },
      tone: 'practical',
      language: 'ja',
      duration_sec: 12,
      format: {
        width: 1280,
        height: 720,
      },
      design_system_ref: {
        system_id: 'operator-ops',
        brand_name: 'Kyberion',
        background_color: '#07111f',
        hero_path: 'active/shared/assets/hero.png',
        logo_path: 'active/shared/assets/logo.png',
        fps: 30,
      },
    });

    expect(storyboard.kind).toBe('video-storyboard');
    expect(storyboard.format.aspect_ratio).toBe('1280:720');
    expect(storyboard.beats).toHaveLength(4);
    expect(storyboard.beats[1].semantic).toBe('process');
    expect(storyboard.beats[1].design_token_hints?.typography_scale).toBe('balanced');
    expect(storyboard.beats[0].layout_variant).toBe('split-left');

    const narrated = compileVideoStoryboardToNarratedVideoBrief(storyboard, {
      narration_artifact_ref: 'active/shared/exports/narration.aiff',
      output: {
        format: 'mp4',
      },
    });

    expect(narrated.kind).toBe('narrated-video-brief');
    expect(narrated.storyboard?.kind).toBe('video-storyboard');
    expect(narrated.script.hook).toContain('clear governed output');
    expect(narrated.script.cta).toContain('content brief');
  });

  it('compiles promo briefs into promo-oriented beats and layout defaults', () => {
    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'prospective customers',
      objective: 'promote a product launch',
      distribution_channel: 'youtube',
      content_type: 'product-launch',
      presentation_mode: 'promo',
      promise: 'launch value in the first beat',
      desired_takeaway: 'click to learn more',
      constraints: ['no generic pitch'],
      proof_points: ['launch date', 'customer proof'],
      design_system_ref: {
        system_id: 'promo-kit',
        brand_name: 'Kyberion',
      },
    });

    expect(storyboard.presentation_mode).toBe('promo');
    expect(storyboard.design_system_ref?.layout_family).toBe('promo-spot');
    expect(storyboard.beats).toHaveLength(4);
    expect(storyboard.beats[1].semantic).toBe('value');
    expect(storyboard.beats[0].design_token_hints?.typography_scale).toBe('expressive');
  });

  it('resolves the shared video mode defaults consistently', () => {
    expect(resolveVideoModeDefaults('howto')).toEqual({
      layout_family: 'process-flow',
      motion_profile: 'guided-step',
      background_color: '#07111f',
    });
    expect(resolveVideoModeDefaults('promo')).toEqual({
      layout_family: 'promo-spot',
      motion_profile: 'energetic',
      background_color: '#08101e',
    });
    expect(resolveDefaultVideoBackgroundColor()).toBe('#07111f');
  });

  it('applies tenant design profiles to storyboard design system vars', () => {
    const designDir = path.join(tenantFixtureRoot, 'design');
    safeMkdir(path.join(designDir, 'assets'), { recursive: true });
    safeWriteFile(
      path.join(designDir, 'tenant-override.json'),
      JSON.stringify(
        {
          tenant_id: 'video-tenant-fixture',
          brand_name: 'Video Tenant',
          matchers: ['video tenant'],
          design_system_id: 'video-tenant-fixture',
          branding: {
            brand_name: 'Video Tenant',
            logo_url: 'knowledge/confidential/video-tenant-fixture/design/assets/logo.png',
          },
          theme_pack_path: 'knowledge/confidential/video-tenant-fixture/design/theme.json',
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(designDir, 'theme.json'),
      JSON.stringify(
        {
          kind: 'web-theme-pack',
          version: '1.0.0',
          theme_id: 'video-tenant-fixture',
          brand_name: 'Video Tenant',
          tenant_slug: 'video-tenant-fixture',
          design_system_id: 'video-tenant-fixture',
          theme: {
            name: 'Video Tenant',
            colors: {
              primary: '#112233',
              secondary: '#334455',
              accent: '#D97706',
              background: '#EEF2FF',
              text: '#111827',
            },
            fonts: {
              heading: 'Aptos Display, sans-serif',
              body: 'Aptos, sans-serif',
            },
          },
        },
        null,
        2
      )
    );

    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'operators',
      objective: 'present tenant branded video content',
      distribution_channel: 'docs-demo',
      content_type: 'howto',
      presentation_mode: 'howto',
      promise: 'tenant branded output',
      desired_takeaway: 'tenant palette is applied',
      constraints: ['keep it governed'],
      proof_points: ['tenant profile', 'theme pack'],
      design_profile: {
        root_dir: tenantRoot,
        customer_id: 'video-tenant-fixture',
        brand_name: 'Video Tenant',
        design_system_id: 'video-tenant-fixture',
      },
      design_system_ref: {
        system_id: 'video-tenant-fixture',
      },
    });

    expect(storyboard.design_system_ref?.brand_name).toBe('Video Tenant');
    expect(storyboard.design_system_ref?.background_color).toBe('#EEF2FF');
    expect(storyboard.design_system_ref?.logo_path).toBe(
      path.join(tenantFixtureRoot, 'design/assets/logo.png')
    );
    expect(storyboard.design_system_ref?.css_vars?.['--kb-bg-main']).toBe('#EEF2FF');
    expect(storyboard.design_system_ref?.css_vars?.['--kb-accent']).toBe('#D97706');
  });

  it('keeps tenant A and tenant B design profiles isolated', () => {
    const tenantAPath = path.join(tenantRoot, 'knowledge/confidential/tenant-a/design');
    const tenantBPath = path.join(tenantRoot, 'knowledge/confidential/tenant-b/design');
    safeMkdir(path.join(tenantAPath, 'assets'), { recursive: true });
    safeMkdir(path.join(tenantBPath, 'assets'), { recursive: true });
    safeWriteFile(
      path.join(tenantAPath, 'tenant-override.json'),
      JSON.stringify(
        {
          tenant_id: 'tenant-a',
          brand_name: 'Tenant A',
          matchers: ['tenant a'],
          design_system_id: 'tenant-a',
          branding: {
            brand_name: 'Tenant A',
            logo_url: 'knowledge/confidential/tenant-a/design/assets/logo.png',
          },
          theme_pack_path: 'knowledge/confidential/tenant-a/design/theme.json',
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(tenantAPath, 'theme.json'),
      JSON.stringify(
        {
          kind: 'web-theme-pack',
          version: '1.0.0',
          theme_id: 'tenant-a',
          brand_name: 'Tenant A',
          tenant_slug: 'tenant-a',
          design_system_id: 'tenant-a',
          theme: {
            name: 'Tenant A',
            colors: {
              primary: '#101010',
              secondary: '#202020',
              accent: '#0EA5E9',
              background: '#F0F9FF',
              text: '#0F172A',
            },
            fonts: {
              heading: 'Tenant A Display',
              body: 'Tenant A Body',
            },
          },
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(tenantBPath, 'tenant-override.json'),
      JSON.stringify(
        {
          tenant_id: 'tenant-b',
          brand_name: 'Tenant B',
          matchers: ['tenant b'],
          design_system_id: 'tenant-b',
          branding: {
            brand_name: 'Tenant B',
            logo_url: 'knowledge/confidential/tenant-b/design/assets/logo.png',
          },
          theme_pack_path: 'knowledge/confidential/tenant-b/design/theme.json',
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(tenantBPath, 'theme.json'),
      JSON.stringify(
        {
          kind: 'web-theme-pack',
          version: '1.0.0',
          theme_id: 'tenant-b',
          brand_name: 'Tenant B',
          tenant_slug: 'tenant-b',
          design_system_id: 'tenant-b',
          theme: {
            name: 'Tenant B',
            colors: {
              primary: '#222244',
              secondary: '#444466',
              accent: '#D97706',
              background: '#FFF7ED',
              text: '#1F2937',
            },
            fonts: {
              heading: 'Tenant B Display',
              body: 'Tenant B Body',
            },
          },
        },
        null,
        2
      )
    );

    const tenantBStoryboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'operators',
      objective: 'present tenant branded video content',
      distribution_channel: 'docs-demo',
      content_type: 'howto',
      presentation_mode: 'howto',
      promise: 'tenant branded output',
      desired_takeaway: 'tenant palette is applied',
      constraints: ['keep it governed'],
      proof_points: ['tenant profile', 'theme pack'],
      design_profile: {
        root_dir: tenantRoot,
        customer_id: 'tenant-b',
        brand_name: 'Tenant B',
        design_system_id: 'tenant-b',
      },
      design_system_ref: {
        system_id: 'tenant-b',
      },
    });

    expect(tenantBStoryboard.design_system_ref?.brand_name).toBe('Tenant B');
    expect(tenantBStoryboard.design_system_ref?.background_color).toBe('#FFF7ED');
    expect(tenantBStoryboard.design_system_ref?.css_vars?.['--kb-bg-main']).toBe('#FFF7ED');
    expect(tenantBStoryboard.design_system_ref?.css_vars?.['--kb-text-primary']).toBe('#1F2937');
  });

  it('compiles vtuber briefs into stage-oriented beats with live presentation hints', () => {
    const storyboard = compileVideoContentBriefToStoryboard({
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'live viewers',
      objective: 'present an on-air persona and demo',
      distribution_channel: 'live-stream',
      content_type: 'vtuber',
      presentation_mode: 'vtuber',
      promise: 'live persona with governed workflow',
      desired_takeaway: 'the viewer sees the persona, demo, and CTA',
      constraints: ['keep it live'],
      proof_points: ['persona', 'demo', 'cta'],
      design_system_ref: {
        system_id: 'vtuber-kit',
        brand_name: 'Kyberion',
      },
    });

    expect(storyboard.presentation_mode).toBe('vtuber');
    expect(storyboard.design_system_ref?.layout_family).toBe('vtuber-stage');
    expect(storyboard.design_system_ref?.css_vars?.['--kb-bg-main']).toBe('#090814');
    expect(storyboard.beats).toHaveLength(4);
    expect(storyboard.beats[0].design_token_hints?.camera_distance).toBe('medium-close');
    expect(storyboard.beats[2].design_token_hints?.overlay_density).toBe('dense');
    expect(storyboard.beats[0].layout_variant).toBe('focus-center');
    expect(storyboard.beats[2].layout_variant).toBe('fullscreen-demo');
  });

  it('keeps schema contracts aligned with design-system video fields', () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    const contentBriefSchema = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/video-content-brief.schema.json')
    );
    const storyboardSchema = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/video-storyboard.schema.json')
    );
    const narratedBriefSchema = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/narrated-video-brief.schema.json')
    );

    const contentBrief = {
      kind: 'video-content-brief',
      version: '1.0.0',
      audience: 'operators',
      objective: 'present an on-air persona and demo',
      distribution_channel: 'live-stream',
      content_type: 'vtuber',
      presentation_mode: 'vtuber',
      promise: 'live persona with governed workflow',
      desired_takeaway: 'the viewer sees the persona, demo, and CTA',
      constraints: ['keep it live'],
      proof_points: ['persona', 'demo', 'cta'],
      format: {
        width: 1080,
        height: 1920,
        aspect_ratio: '9:16',
      },
      design_system_ref: {
        system_id: 'vtuber-kit',
        brand_name: 'Kyberion',
        css_vars: {
          '--kb-bg-main': '#101827',
          '--kb-panel-radius': '28px',
        },
      },
    };

    expect(contentBriefSchema(contentBrief)).toBe(true);

    const storyboard = compileVideoContentBriefToStoryboard(contentBrief as any);
    expect(storyboardSchema(storyboard)).toBe(true);

    const narrated = compileVideoStoryboardToNarratedVideoBrief(storyboard, {
      narration_artifact_ref: 'active/shared/exports/narration.aiff',
      output: { format: 'mp4' },
    });
    expect(narratedBriefSchema(narrated)).toBe(true);
  });
});
