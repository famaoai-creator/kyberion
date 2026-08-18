import { describe, expect, it } from 'vitest';
import {
  getReasoningRuntimeInstructions,
  renderRuntimeInstructions,
  runtimeInstructionsForProvider,
} from './reasoning-runtime-instructions.js';
import { activatePluginContributions } from './plugin-contributions.js';

describe('reasoning runtime instructions', () => {
  it('selects provider-specific notes through routing wrappers', () => {
    const instructions = getReasoningRuntimeInstructions(
      {
        name: 'role-aware',
        getRuntimeProviderName: () => 'codex-cli',
        getRuntimeInstructions: () => ['custom provider hook'],
      },
      { route_profile: 'implementer' }
    );
    expect(instructions).toContain('custom provider hook');
    expect(instructions.some((line) => line.includes('inspect before editing'))).toBe(true);
  });

  it('renders a stable prompt section', () => {
    const section = renderRuntimeInstructions(runtimeInstructionsForProvider('agy-cli'));
    expect(section).toContain('## Provider runtime instructions');
    expect(section).toContain('structured and bounded');
  });

  it('includes only activated plugin prompt sections in runtime instructions', async () => {
    const activation = await activatePluginContributions(
      { prompt_sections: ['runtime-note'] },
      {
        pluginId: 'runtime-plugin',
        sourcePath: '/managed/runtime/index.mjs',
        trust: 'third-party',
      },
      {
        registerKyberionContributions: (api) =>
          api.registerPromptSection('runtime-note', 'Preserve the plugin execution contract.'),
      }
    );
    try {
      const instructions = getReasoningRuntimeInstructions({
        name: 'stub',
        getRuntimeInstructions: () => [],
        getRuntimeProviderName: () => 'stub',
      });
      expect(instructions).toContain(
        'Plugin contribution [runtime-plugin:runtime-note]: Preserve the plugin execution contract.'
      );
    } finally {
      activation.dispose();
    }
    const after = getReasoningRuntimeInstructions({ name: 'stub' });
    expect(after.some((entry) => entry.includes('runtime-plugin:runtime-note'))).toBe(false);
  });
});
