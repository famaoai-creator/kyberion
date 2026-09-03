import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getServicePresetRecord,
  loadServicePresetAtPath,
  loadServicePresetsCatalog,
  resolveServicePresetPath,
} from './service-preset-registry.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';

const TMP_ROOT = path.join(process.cwd(), 'active/shared/tmp/service-preset-registry-test');

describe('service-preset-registry', () => {
  it('loads the canonical service presets directory', () => {
    const catalog = loadServicePresetsCatalog();
    expect(Object.keys(catalog.services)).toEqual(
      expect.arrayContaining([
        'slack',
        'comfyui',
        'voice',
        'asana',
        'figma',
        'stripe',
        'cloudflare',
      ])
    );
  });

  it('resolves a service preset by service id', () => {
    const preset = getServicePresetRecord('slack');
    expect(preset?.service_id).toBe('slack');
    expect(preset?.operations).toHaveProperty('post_message');
  });

  it('includes GitHub Actions operations in the canonical preset', () => {
    const preset = getServicePresetRecord('github');
    expect(preset?.service_id).toBe('github');
    expect(preset?.operations).toHaveProperty('actions_list_runs');
    expect(preset?.operations).toHaveProperty('actions_get_run');
    expect(preset?.operations).toHaveProperty('actions_dispatch_workflow');
  });

  it('resolves common SaaS presets', () => {
    expect(getServicePresetRecord('asana')?.operations).toHaveProperty('create_task');
    expect(getServicePresetRecord('figma')?.operations).toHaveProperty('get_file');
    expect(getServicePresetRecord('stripe')?.operations).toHaveProperty('create_payment_intent');
    expect(getServicePresetRecord('cloudflare')?.operations).toHaveProperty('create_dns_record');
  });

  it('resolves a service preset path for a canonical service id', () => {
    expect(resolveServicePresetPath('comfyui')).toContain(
      'knowledge/product/orchestration/service-presets/comfyui.json'
    );
  });

  it('resolves a service preset from an explicit hint path', () => {
    const preset = getServicePresetRecord(
      'voice',
      'knowledge/product/orchestration/service-presets/voice.json'
    );
    expect(preset?.service_id).toBe('voice');
    expect(preset?.operations).toHaveProperty('speak_local');
  });

  it('binds a legacy explicit preset without service_id through the canonical loader', () => {
    safeMkdir(TMP_ROOT, { recursive: true });
    const presetPath = path.join(TMP_ROOT, 'legacy-service.json');
    safeWriteFile(presetPath, JSON.stringify({ operations: {} }, null, 2));

    const preset = loadServicePresetAtPath(presetPath, 'legacy-service');

    expect(preset.service_id).toBe('legacy-service');
  });
});
