#!/usr/bin/env node
import { pathResolver } from '@agent/core/path-resolver';
import { loadPiiRules } from '@agent/core/pii-scrubber';
import { defineGenerator, isDirectScript } from './lib/harness.js';

// Every extension that sends observed content to an on-device model shares the
// same redaction boundary; each one gets its own copy because MV3 extensions
// cannot load scripts from outside their own directory.
const outputPaths = [
  pathResolver.rootResolve('tools/adf-replay-extension/pii-rules.generated.js'),
  pathResolver.rootResolve('tools/meet-copilot-extension/pii-rules.generated.js'),
];

function loadRules(): Array<{ id: string; regex: string }> {
  return loadPiiRules()
    .map((rule) => ({ id: rule.id, regex: rule.pattern }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function render(): string {
  const rules = loadRules();
  const renderedRules = rules
    .map(
      (rule) =>
        `    { id: ${JSON.stringify(rule.id)}, pattern: new RegExp(${JSON.stringify(rule.regex)}, 'gu'), replacement: ${JSON.stringify(`[REDACTED:${rule.id}]`)} },`
    )
    .join('\n');
  return `// GENERATED FROM knowledge/product/governance/knowledge-sync-rules.json.\n// Run pnpm generate:pii-rules after changing the governed source.\nglobalThis.__kyberionPiiScrub = (value) => {\n  let text = String(value ?? '');\n  const rules = [\n${renderedRules}\n  ];\n  for (const rule of rules) {\n    try { text = text.replace(rule.pattern, rule.replacement); } catch { return '[REDACTED:pii-rule-error]'; }\n  }\n  return text;\n};\n`;
}

export const runGeneratePiiRules = defineGenerator({
  id: 'pii-rules',
  outputs: outputPaths,
  render: () => {
    const content = render();
    return outputPaths.map((filePath) => ({ path: filePath, content }));
  },
});

if (
  isDirectScript(import.meta.url, 'generate_pii_rules.ts') ||
  isDirectScript(import.meta.url, 'generate_pii_rules.js')
)
  void runGeneratePiiRules();
