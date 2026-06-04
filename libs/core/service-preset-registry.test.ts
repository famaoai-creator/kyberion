import { describe, expect, it } from 'vitest';

import {
  getServicePresetRecord,
  loadServicePresetsCatalog,
  resolveServicePresetPath,
} from './service-preset-registry.js';

describe('service-preset-registry', () => {
  it('loads the canonical service presets directory', () => {
    const catalog = loadServicePresetsCatalog();
    expect(Object.keys(catalog.services)).toEqual(expect.arrayContaining(['slack', 'comfyui', 'voice']));
  });

  it('resolves a service preset by service id', () => {
    const preset = getServicePresetRecord('slack');
    expect(preset?.service_id).toBe('slack');
    expect(preset?.operations).toHaveProperty('post_message');
  });

  it('resolves a service preset path for a canonical service id', () => {
    expect(resolveServicePresetPath('comfyui')).toContain('knowledge/product/orchestration/service-presets/comfyui.json');
  });

  it('resolves a service preset from an explicit hint path', () => {
    const preset = getServicePresetRecord('voice', 'knowledge/product/orchestration/service-presets/voice.json');
    expect(preset?.service_id).toBe('voice');
    expect(preset?.operations).toHaveProperty('speak_local');
  });
});
