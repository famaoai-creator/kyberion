#!/usr/bin/env tsx
/**
 * create_actuator.ts — Scaffold a new Kyberion actuator from the canonical template.
 *
 * Usage:
 *   pnpm kyberion create actuator <name>           e.g. pnpm kyberion create actuator my-feature
 *   pnpm kyberion create actuator <name> --desc "What this actuator does"
 *
 * Generates:
 *   libs/actuators/<name>-actuator/
 *     manifest.json
 *     package.json
 *     src/index.ts
 *     knowledge/product/schemas/<name>-action.schema.json
 *     examples/README.md
 *
 * Pattern from Paper2Any's `dfa create` scaffolding CLI (Apache 2.0).
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

type Print = (value: unknown) => void;

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

export interface ActuatorScaffoldPreview extends ActuatorScaffoldResult {
  files_to_write: string[];
}

export interface ActuatorScaffoldMachineResult extends ActuatorScaffoldPreview {
  ok: true;
  mode: 'check' | 'dry-run';
}

function buildManifest(fullName: string, description: string, name: string): string {
  return JSON.stringify(
    {
      actuator_id: fullName,
      version: '1.0.0',
      description,
      contract_schema: `knowledge/product/schemas/${name}-action.schema.json`,
      resilience_tier: 'adaptive_retry',
      recovery_policy: {
        fallback_strategy: 'sequential_alternatives',
        retry: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 10000, factor: 2, jitter: true },
        retryable_categories: ['network', 'timeout', 'resource_unavailable'],
      },
      capabilities: [
        {
          op: 'execute',
          schema_ref: `knowledge/product/schemas/${name}-action.schema.json`,
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

function buildIndexTs(fullName: string, _pascalName: string, _name: string): string {
  return `import { defineActuator } from '@agent/core/actuator-sdk';
import { logger } from '@agent/core/core';
import { nowIso } from '@agent/core/foundation';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

const executeInputSchema = {
  type: 'object',
  description: 'Replace this scaffold contract with the actuator-specific input schema.',
  additionalProperties: true,
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Actuator input must be an object.');
  }
  return value as Record<string, unknown>;
}

// ── Op implementation ───────────────────────────────────────────────────────

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
      updated_at: nowIso(),
    },
  };
}

export const actuator = defineActuator({
  id: '${fullName}',
  ops: {
    execute: {
      kind: 'apply',
      input_schema: executeInputSchema,
      validateInput: asRecord,
      handler: opExecute,
    },
  },
});

export async function main(): Promise<void> {
  await runActuatorCli({ args: currentProcessArgv(), name: '${fullName}', actuator });
}

if (import.meta.main) void runActuatorCliEntryPoint(main, '${fullName}');
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

function buildActuatorScaffoldPlan(input: ActuatorScaffoldInput): {
  result: ActuatorScaffoldResult;
  files: Array<{ path: string; content: string }>;
} {
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
  const safeOutDir = assertSafeRepositoryPath(outDir, {
    allowMissingLeaf: true,
    rootDir,
  });

  if (safeExistsSync(safeOutDir)) {
    throw new Error(`Directory already exists: ${outDir}`);
  }

  const files = [
    {
      path: path.join(safeOutDir, 'manifest.json'),
      content: `${buildManifest(fullName, description, name)}\n`,
    },
    {
      path: path.join(safeOutDir, 'package.json'),
      content: `${buildPackage(description, name, fullName)}\n`,
    },
    {
      path: path.join(safeOutDir, 'src', 'index.ts'),
      content: buildIndexTs(fullName, pascalName, name),
    },
    {
      path: path.join(safeOutDir, 'schemas', `${name}-action.schema.json`),
      content: `${buildSchema(pascalName)}\n`,
    },
    {
      path: path.join(safeOutDir, 'examples', 'README.md'),
      content: buildExamplesReadme(pascalName, name, envName),
    },
  ].map((file) => ({
    ...file,
    path: assertSafeRepositoryPath(file.path, { allowMissingLeaf: true, rootDir }),
  }));

  return {
    result: {
      outDir: safeOutDir,
      files: [
        'manifest.json',
        'package.json',
        'src/index.ts',
        `knowledge/product/schemas/${name}-action.schema.json`,
        'examples/README.md',
      ],
      name: fullName,
      description,
    },
    files,
  };
}

export function previewActuatorScaffold(input: ActuatorScaffoldInput): ActuatorScaffoldPreview {
  const plan = buildActuatorScaffoldPlan(input);
  return {
    ...plan.result,
    files_to_write: plan.files.map((file) => file.path),
  };
}

export function createActuatorScaffold(input: ActuatorScaffoldInput): ActuatorScaffoldResult {
  const plan = buildActuatorScaffoldPlan(input);
  for (const file of plan.files) {
    safeMkdir(path.dirname(file.path), { recursive: true });
    safeWriteFile(file.path, file.content);
  }
  return plan.result;
}

function parseCliArgs(args: string[]): ActuatorScaffoldInput {
  const argv = createStandardYargs(['node', 'create_actuator', ...args])
    .option('name', { type: 'string', describe: 'Actuator name' })
    .option('desc', { type: 'string', describe: 'Human-readable description' })
    .parseSync();

  const positional = argv._.map(String).filter(Boolean);
  const name = (argv.name as string | undefined) || positional[0];
  if (!name || name.startsWith('-')) {
    throw new Error('Usage: pnpm kyberion create actuator <name> [--desc "description"]');
  }

  return {
    name,
    description: typeof argv.desc === 'string' ? argv.desc : undefined,
  };
}

async function main(
  args: string[],
  options: {
    dryRun?: boolean;
    check?: boolean;
    json?: boolean;
    quiet?: boolean;
    print?: Print;
  } = {}
): Promise<ActuatorScaffoldResult | ActuatorScaffoldMachineResult> {
  const input = parseCliArgs(args);
  const machineOutput =
    options.json === true ||
    options.dryRun === true ||
    options.check === true ||
    options.quiet === true;
  if (options.dryRun === true || options.check === true) {
    return {
      ok: true,
      ...previewActuatorScaffold(input),
      mode: options.check === true ? 'check' : 'dry-run',
    };
  }

  const scaffold = createActuatorScaffold(input);
  if (!machineOutput) {
    const print = options.print ?? (() => undefined);
    logger.success(`✓ Scaffolded ${scaffold.name} at ${path.relative(ROOT, scaffold.outDir)}/`);
    print('  Files created:');
    for (const file of scaffold.files) print(`    ${file}`);
    print('\nNext steps:');
    print('  1. Implement the actuator-specific op logic in src/index.ts');
    print('  2. Replace the schema stub with the real contract');
    print('  3. Add an entry to CAPABILITIES_GUIDE.md');
    print('  4. Run: pnpm build');
    print(
      '  5. Run: pnpm generate:op-registry — register the ops in the op registry/discovery catalog (pnpm generate:op-registry -- --check verifies drift)'
    );
  }
  return scaffold;
}

const script = defineScript({
  name: 'create:actuator',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: ({ argv, dryRun, check, json, quiet, print }) =>
    main(stripSharedScriptFlags(argv), { dryRun, check, json, quiet, print }).then((result) => {
      if (json || dryRun || check) print(result);
      return result;
    }),
});
if (
  isDirectScript(import.meta.url, 'create_actuator.ts') ||
  isDirectScript(import.meta.url, 'create_actuator.js')
) {
  void script();
}
