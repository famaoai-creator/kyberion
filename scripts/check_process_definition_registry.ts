import { assertProcessDefinitionRegistry } from '@agent/core/process-definition-registry';
import { defineScript, isDirectScript } from './lib/harness.js';

export function checkProcessDefinitionRegistry() {
  return assertProcessDefinitionRegistry();
}

export const runCheckProcessDefinitionRegistry = defineScript({
  name: 'check:process-definition-registry',
  flags: [],
  run(context) {
    const audit = checkProcessDefinitionRegistry();
    context.print(
      `✅ Process definition registry valid: ${audit.sources.length} sources (${audit.sources
        .map((source) => `${source.id}:${source.execution_role}`)
        .join(', ')})`
    );
    return audit;
  },
});

if (
  isDirectScript(import.meta.url, 'check_process_definition_registry.ts') ||
  isDirectScript(import.meta.url, 'check_process_definition_registry.js')
)
  void runCheckProcessDefinitionRegistry();
