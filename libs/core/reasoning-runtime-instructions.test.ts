import { describe, expect, it } from 'vitest';
import {
  getReasoningRuntimeInstructions,
  renderRuntimeInstructions,
  runtimeInstructionsForProvider,
} from './reasoning-runtime-instructions.js';

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
});
