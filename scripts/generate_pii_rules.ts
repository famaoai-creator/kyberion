#!/usr/bin/env node
import { pathResolver, safeReadFile, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

type SourceRule = { id?: string; name?: string; regex?: string };

const sourcePath = pathResolver.knowledge('product/governance/knowledge-sync-rules.json');
const outputPath = pathResolver.rootResolve('tools/adf-replay-extension/pii-rules.generated.js');

function loadRules(): Array<{ id: string; regex: string }> {
  const source = JSON.parse(String(safeReadFile(sourcePath, { encoding: 'utf8' }))) as {
    security?: { pii_patterns?: SourceRule[] };
  };
  const rules = source.security?.pii_patterns;
  if (!Array.isArray(rules) || rules.length === 0)
    throw new Error('knowledge-sync-rules.json has no security.pii_patterns');
  return rules
    .map((rule) => ({ id: String(rule.id || rule.name || ''), regex: String(rule.regex || '') }))
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

const expected = render();
if (process.argv.includes('--check')) {
  const actual = String(safeReadFile(outputPath, { encoding: 'utf8' }));
  if (actual !== expected) {
    console.error(`[check:pii-rules] generated file is stale: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log('[check:pii-rules] OK');
  }
} else {
  withExecutionContext(
    'ecosystem_architect',
    () => safeWriteFile(outputPath, expected, { encoding: 'utf8' }),
    'ecosystem_architect'
  );
  console.log(`[generate:pii-rules] wrote ${outputPath}`);
}
