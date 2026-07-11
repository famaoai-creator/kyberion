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
 *     schemas/<name>-action.schema.json
 *     examples/README.md
 *
 * Pattern from Paper2Any's `dfa create` scaffolding CLI (Apache 2.0).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyError,
  createStandardYargs,
  formatClassification,
  logger,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function pascal(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join('');
}

function scream(s: string): string {
  return s.toUpperCase().replace(/-/g, '_');
}

export interface ActuatorScaffoldInput {
  name: string;
  description?: string;
  rootDir?: string;
}

export interface ActuatorScaffoldResult {
  outDir: string;
  files: string[];
  name: string;
  description: string;
}

function buildManifest(fullName: string, description: string, name: string): string {
  return JSON.stringify(
    {
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
        {
          op: 'execute',
          schema_ref: `schemas/${name}-action.schema.json`,
          platforms: ['darwin', 'linux', 'win32'],
        },
      ],
    },
    null,
    2
  );
}

function buildPackage(description: string, name: string, fullName: string): string {
  return JSON.stringify(
    {
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
    },
    null,
    2
  );
}

function buildIndexTs(fullName: string, pascalName: string): string {
  return `import { logger, classifyError } from '@agent/core';
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
  const currentState = typeof ctx.state === 'object' && ctx.state !== null ? ctx.state as Record<string, unknown> : {};
  logger.info(\`[${fullName}] execute: \${JSON.stringify(params)}\`);
  return {
    ...ctx,
    actuator_id: '${fullName}',
    last_operation: 'execute',
    received_params: params,
    state: {
      ...currentState,
      updated_at: new Date().toISOString(),
    },
  };
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
}

function buildSchema(pascalName: string): string {
  return JSON.stringify(
    {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: `${pascalName}Action`,
      type: 'object',
      required: ['op'],
      properties: {
        op: {
          type: 'string',
          enum: ['execute'],
        },
        params: {
          type: 'object',
          description: 'Arbitrary execute parameters passed to the actuator scaffold.',
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    null,
    2
  );
}

function buildExamplesReadme(pascalName: string, name: string, envName: string): string {
  return `# ${pascalName} Actuator — Examples

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
}

export function createActuatorScaffold(input: ActuatorScaffoldInput): ActuatorScaffoldResult {
  const rawName = input.name.trim();
  if (!rawName) {
    throw new Error('Missing actuator name');
  }

  const name = kebab(rawName.replace(/-actuator$/, ''));
  const fullName = `${name}-actuator`;
  const pascalName = pascal(name);
  const envName = scream(name);
  const description = input.description?.trim() || `${pascalName} actuator for Kyberion`;
  const rootDir = input.rootDir || ROOT;
  const outDir = path.join(rootDir, 'libs', 'actuators', fullName);

  if (safeExistsSync(outDir)) {
    throw new Error(`Directory already exists: ${outDir}`);
  }

  safeMkdir(path.join(outDir, 'src'));
  safeMkdir(path.join(outDir, 'examples'));
  safeMkdir(path.join(outDir, 'schemas'));

  safeWriteFile(
    path.join(outDir, 'manifest.json'),
    `${buildManifest(fullName, description, name)}\n`
  );
  safeWriteFile(
    path.join(outDir, 'package.json'),
    `${buildPackage(description, name, fullName)}\n`
  );
  safeWriteFile(path.join(outDir, 'src', 'index.ts'), buildIndexTs(fullName, pascalName));
  safeWriteFile(
    path.join(outDir, 'schemas', `${name}-action.schema.json`),
    `${buildSchema(pascalName)}\n`
  );
  safeWriteFile(
    path.join(outDir, 'examples', 'README.md'),
    buildExamplesReadme(pascalName, name, envName)
  );

  return {
    outDir,
    files: [
      'manifest.json',
      'package.json',
      'src/index.ts',
      `schemas/${name}-action.schema.json`,
      'examples/README.md',
    ],
    name: fullName,
    description,
  };
}

function parseCliArgs(): ActuatorScaffoldInput {
  const argv = createStandardYargs()
    .option('name', { type: 'string', describe: 'Actuator name' })
    .option('desc', { type: 'string', describe: 'Human-readable description' })
    .parseSync();

  const positional = argv._.map(String).filter(Boolean);
  const name = (argv.name as string | undefined) || positional[0];
  if (!name || name.startsWith('-')) {
    throw new Error('Usage: pnpm create:actuator <name> [--desc "description"]');
  }

  return {
    name,
    description: typeof argv.desc === 'string' ? argv.desc : undefined,
  };
}

async function main(): Promise<void> {
  try {
    const scaffold = createActuatorScaffold(parseCliArgs());
    logger.success(`✓ Scaffolded ${scaffold.name} at ${path.relative(ROOT, scaffold.outDir)}/`);
    console.log('  Files created:');
    for (const file of scaffold.files) {
      console.log(`    ${file}`);
    }
    console.log('\nNext steps:');
    console.log('  1. Implement the actuator-specific op logic in src/index.ts');
    console.log('  2. Replace the schema stub with the real contract');
    console.log('  3. Add an entry to CAPABILITIES_GUIDE.md');
    console.log('  4. Run: pnpm build');
    console.log(
      '  5. Run: pnpm generate:op-registry — register the ops in the op registry/discovery catalog (pnpm validate enforces this via check:op-registry)'
    );
  } catch (err: any) {
    logger.error(formatClassification(classifyError(err)));
    process.exit(1);
  }
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  await main();
}
