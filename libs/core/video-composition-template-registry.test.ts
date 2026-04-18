import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeWriteFile } from '@agent/core';
import {
  getVideoCompositionTemplateRecord,
  getVideoCompositionTemplateRegistry,
  listVideoCompositionTemplates,
  resetVideoCompositionTemplateRegistryCache,
} from './video-composition-template-registry.js';

describe('video composition template registry', () => {
  const tmpDir = pathResolver.sharedTmp('video-template-registry-tests');
  const overridePath = `${tmpDir}/video-composition-template-registry.json`;

  afterEach(() => {
    delete process.env.KYBERION_VIDEO_COMPOSITION_TEMPLATE_REGISTRY_PATH;
    resetVideoCompositionTemplateRegistryCache();
  });

  it('loads template registry overrides', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        default_template_id: 'proof-card',
        templates: [
          {
            template_id: 'proof-card',
            display_name: 'Proof Card',
            status: 'active',
            renderer: 'builtin_html',
            supported_roles: ['proof'],
            required_content_fields: ['headline', 'body'],
            supported_output_formats: ['mp4'],
          },
        ],
      }),
    );
    process.env.KYBERION_VIDEO_COMPOSITION_TEMPLATE_REGISTRY_PATH = overridePath;

    const registry = getVideoCompositionTemplateRegistry();
    expect(registry.default_template_id).toBe('proof-card');
    expect(getVideoCompositionTemplateRecord().template_id).toBe('proof-card');
    expect(listVideoCompositionTemplates('active')).toHaveLength(1);
  });
});
