#!/usr/bin/env tsx
/**
 * create_actuator.ts — Scaffold a new Kyberion actuator from the canonical template.
 *
 * Usage:
 *   pnpm create:actuator <name>           e.g. pnpm create:actuator my-feature
 *   pnpm create:actuator <name> --desc "What this actuator does"
 *
 * Generates:
 *   libs/actuators/<name>-actuator/
 *     manifest.json
 *     package.json
 *     src/index.ts
 *     examples/README.md
 *
 * Pattern from Paper2Any's `dfa create` scaffolding CLI (Apache 2.0).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function kebab(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function pascal(s: string) { return s.split(/[-_\s]+/).map(w => w[0]?.toUpperCase() + w.slice(1)).join(''); }
function scream(s: string) { return s.toUpperCase().replace(/-/g, '_'); }

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) {
  console.error('Usage: pnpm create:actuator <name> [--desc "description"]');
  process.exit(1);
}

const rawName = args[0];
const descIdx = args.indexOf('--desc');
const description = descIdx !== -1 ? (args[descIdx + 1] ?? '') : `${pascal(rawName)} actuator for Kyberion`;

const name = kebab(rawName.replace(/-actuator$/, ''));     // strip -actuator suffix if present
const fullName = `${name}-actuator`;
const pascalName = pascal(name);
const envName = scream(name);
const outDir = path.join(ROOT, 'libs', 'actuators', fullName);

if (fs.existsSync(outDir)) {
  console.error(`✗ Directory already exists: ${outDir}`);
  process.exit(1);
}

// ── Templates ────────────────────────────────────────────────────────────────

const MANIFEST = JSON.stringify({
  actuator_id: fullName,
  version: '1.0.0',
  description,
  contract_schema: `schemas/${name}-action.schema.json`,
  resilience_tier: 'adaptive_retry',
  recovery_policy: {
    fallback_strategy: 'sequential_alternatives',
    retry: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 10000, factor: 2, jitter: true },
    retryable_categories: ['network', 'timeout', 'resource_unavailable'],
  },
  capabilities: [
    { op: 'execute', schema_ref: `schemas/${name}-action.schema.json`, platforms: ['darwin', 'linux', 'win32'] },
  ],
}, null, 2);

const PACKAGE = JSON.stringify({
  name: `@actuator/${name}`,
  version: '1.0.0',
  type: 'module',
  description,
  main: `../../../dist/libs/actuators/${fullName}/src/index.js`,
  types: `../../../dist/libs/actuators/${fullName}/src/index.d.ts`,
  scripts: {
    build: 'tsc -p ../../../tsconfig.actuators.json',
    test: 'vitest run',
  },
  dependencies: {
    '@agent/core': 'workspace:*',
    chalk: '^5.3.0',
    yargs: '^17.7.2',
  },
}, null, 2);

const INDEX_TS = `import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  pathResolver,
  resolveVars,
  classifyError,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

// ── Op dispatch ─────────────────────────────────────────────────────────────

export async function dispatch${pascalName}Op(
  op: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<{ handled: boolean; ctx: Record<string, unknown> }> {
  try {
    switch (op) {
      case 'execute':
        return { handled: true, ctx: await opExecute(params, ctx) };

      default:
        logger.warn(\`[${fullName}] Unknown op: \${op}\`);
        return { handled: false, ctx };
    }
  } catch (err: any) {
    const classification = classifyError(err);
    logger.error(\`[${fullName}] \${op} failed (\${classification.category}): \${err.message}\`);
    throw err;
  }
}

// Re-export under the generic name expected by run_pipeline.ts
export const dispatchDecisionOp = dispatch${pascalName}Op;

// ── Op implementations ──────────────────────────────────────────────────────

async function opExecute(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // TODO: implement
  logger.info(\`[${fullName}] execute: \${JSON.stringify(params)}\`);
  return { ...ctx };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  const argv = await createStandardYargs()
    .option('op', { type: 'string', demandOption: true, describe: 'Operation to run' })
    .option('params', { type: 'string', default: '{}', describe: 'JSON params' })
    .parseAsync();

  const params = JSON.parse(argv.params as string);
  const result = await dispatch${pascalName}Op(argv.op as string, params, {});
  console.log(JSON.stringify(result.ctx, null, 2));
}
`;

const EXAMPLES_README = `# ${pascalName} Actuator — Examples

See [CAPABILITIES_GUIDE.md](../../../../CAPABILITIES_GUIDE.md) for the full actuator catalog.

## Basic usage in a pipeline

\`\`\`json
{
  "op": "${name}:execute",
  "params": {
    "example_param": "value"
  },
  "export_as": "result"
}
\`\`\`

## Setup

Register any required secrets via \`secret:set\` before running:

\`\`\`json
{ "op": "secret:set", "params": { "key": "${envName}_API_KEY", "value": "your-key-here" } }
\`\`\`
`;

// ── Write files ──────────────────────────────────────────────────────────────

fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'examples'), { recursive: true });

fs.writeFileSync(path.join(outDir, 'manifest.json'), MANIFEST + '\n');
fs.writeFileSync(path.join(outDir, 'package.json'), PACKAGE + '\n');
fs.writeFileSync(path.join(outDir, 'src', 'index.ts'), INDEX_TS);
fs.writeFileSync(path.join(outDir, 'examples', 'README.md'), EXAMPLES_README);

console.log(`\n✓ Scaffolded ${fullName} at libs/actuators/${fullName}/\n`);
console.log('  Files created:');
console.log(`    manifest.json          — actuator metadata and capabilities`);
console.log(`    package.json           — workspace package`);
console.log(`    src/index.ts           — op dispatch + CLI entry point`);
console.log(`    examples/README.md     — copy-paste pipeline snippets`);
console.log(`\nNext steps:`);
console.log(`  1. Add your ops to src/index.ts`);
console.log(`  2. Create schemas/${name}-action.schema.json`);
console.log(`  3. Add an entry to CAPABILITIES_GUIDE.md`);
console.log(`  4. Run: pnpm build\n`);
