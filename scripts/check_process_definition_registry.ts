import { assertProcessDefinitionRegistry } from '@agent/core';

const audit = assertProcessDefinitionRegistry();
console.log(
  `✅ Process definition registry valid: ${audit.sources.length} sources (${audit.sources
    .map((source) => `${source.id}:${source.execution_role}`)
    .join(', ')})`
);
