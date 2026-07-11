import { describe, expect, it } from 'vitest';

import {
  getServicePresetRecord,
  loadServicePresetsCatalog,
  resolveServicePresetPath,
} from './service-preset-registry.js';

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
});
