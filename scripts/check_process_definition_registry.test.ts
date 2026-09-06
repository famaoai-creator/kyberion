import { describe, expect, it } from 'vitest';
import { checkProcessDefinitionRegistry } from './check_process_definition_registry.js';

describe('process definition registry checker', () => {
  it('validates the governed process definitions without import-time execution', () => {
    const audit = checkProcessDefinitionRegistry();
    expect(audit.sources.length).toBeGreaterThan(0);
  });
});
