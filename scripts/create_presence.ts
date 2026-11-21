#!/usr/bin/env node
/**
 * create_presence.ts — scaffold a new `presence/` workspace package and do its
 * registration ceremony in one step.
 *
 * Usage:
 *   pnpm kyberion create presence displays/<name> [--desc "what it shows"]
 *   pnpm kyberion create presence bridge/<name>
 *
 * Adding a presence package by hand touches a dozen root files, and each one
 * forgotten fails a separate gate after the push (MSN-TUI-DECK-20261120
 * retrospective). This writes the package and every mechanical registration:
 *
 *   presence/<group>/<name>/{package.json,tsconfig.json,README.md,src/index.ts,src/index.test.ts}
 *   tsconfig.json             root exclude + project reference
 *   tsconfig.packages.json    project reference (package build order)
 *   scripts/build-output-layout.ts  build output + root-source exclusion
 *   .github/workflows/{ci,cross-os,pr-validation}.yml  dist build cache paths
 *   knowledge/product/governance/i18n-baseline.json    scan root
 *   docs/developer/architecture/dependency-graph.mmd   regenerated
 *
 * Steps that need a decision (lockfile install + its review evidence, a root
 * entrypoint, docs prose) are printed as next steps instead.
 * Every edit is planned before any write: a missing anchor changes nothing.
 */
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';
import {
  collectWorkspacePackages,
  GRAPH_FILE,
  renderDependencyGraph,
} from './generate/generate_package_dependency_graph.js';

type Print = (value: unknown) => void;

/** Groups covered by pnpm-workspace.yaml (`presence/sensors` is not a workspace). */
export const PRESENCE_GROUPS = ['displays', 'bridge'] as const;
export type PresenceGroup = (typeof PRESENCE_GROUPS)[number];

export interface PresenceScaffoldInput {
  /** `displays/<name>` or `bridge/<name>`. */
  target: string;
  description?: string;
  rootDir?: string;
  /** Existing workspace packages (name + dir); defaults to this repository's. */
  workspacePackages?: ReadonlyArray<{ name: string; dir: string }>;
}

export interface PresenceScaffoldPlan {
  packageId: string;
  packageName: string;
  outDir: string;
  created: Record<string, string>;
  updated: Record<string, string>;
  unchanged: string[];
}

export interface PresenceScaffoldResult {
  packageId: string;
  packageName: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  nextSteps: string[];
}

const WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/cross-os.yml',
  '.github/workflows/pr-validation.yml',
];

export function parsePresenceTarget(target: string): { group: PresenceGroup; name: string } {
  const match = /^([a-z]+)\/([a-z][a-z0-9-]{1,40})$/u.exec(target);
  if (!match || !PRESENCE_GROUPS.includes(match[1] as PresenceGroup) || match[2]!.endsWith('-')) {
    throw new Error(
      `Usage: pnpm kyberion create presence <${PRESENCE_GROUPS.join('|')}>/<kebab-name> — got "${target}"`
    );
  }
  return { group: match[1] as PresenceGroup, name: match[2]! };
}

function read(root: string, file: string): string {
  const absolute = path.join(root, file);
  if (!safeExistsSync(absolute)) throw new Error(`[CREATE_PRESENCE_ANCHOR] ${file} not found`);
  return String(safeReadFile(absolute, { encoding: 'utf8' }));
}

/** Insert `line` before the first line equal to `anchor` (after trimming), once. */
function insertBefore(source: string, file: string, anchor: string, line: string): string {
  const lines = source.split('\n');
  const index = lines.findIndex((candidate) => candidate.trim() === anchor);
  if (index < 0) throw new Error(`[CREATE_PRESENCE_ANCHOR] ${file}: line "${anchor}" not found`);
  const indent = /^\s*/u.exec(lines[index]!)![0];
  lines.splice(index, 0, `${indent}${line}`);
  return lines.join('\n');
}

function editJson(source: string, edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(source) as Record<string, unknown>;
  edit(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function addReference(value: Record<string, unknown>, ref: string): void {
  const refs = (value.references ??= []) as Array<{ path: string }>;
  if (!refs.some((entry) => entry.path === ref)) refs.push({ path: ref });
}

function packageFiles(packageId: string, packageName: string, description: string) {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    [`${packageId}/package.json`]: json({
      name: packageName,
      version: '0.1.0',
      type: 'module',
      description,
      main: './dist/index.js',
      types: './dist/index.d.ts',
      scripts: { build: 'tsc --build && node ../../../scripts/write_core_dist_scope.mjs --run' },
      dependencies: { '@agent/core': 'workspace:*' },
      devDependencies: { '@types/node': '^26.6.5', typescript: '^5.9.3' },
    }),
    [`${packageId}/tsconfig.json`]: json({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        rootDir: 'src',
        composite: true,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        incremental: true,
        tsBuildInfoFile: './dist/.tsbuildinfo',
        noImplicitAny: true,
      },
      references: [{ path: '../../../libs/core' }],
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
      extends: '../../../tsconfig.base.json',
    }),
    [`${packageId}/README.md`]: [
      `# ${packageName}`,
      '',
      description,
      '',
      '## Development',
      '',
      '```bash',
      `pnpm --filter ${packageName} build`,
      `pnpm exec vitest run ${packageId}`,
      '```',
      '',
      'File I/O goes through `@agent/core/secure-io` only; on-screen text lives in `user-facing-vocabulary.json`.',
      '',
    ].join('\n'),
    [`${packageId}/src/index.ts`]: [
      `/** ${description} */`,
      '',
      `export const PACKAGE_NAME = '${packageName}';`,
      '',
    ].join('\n'),
    [`${packageId}/src/index.test.ts`]: [
      "import { describe, expect, it } from 'vitest';",
      "import { PACKAGE_NAME } from './index.js';",
      '',
      `describe('${packageName}', () => {`,
      "  it('exports its package name', () => {",
      `    expect(PACKAGE_NAME).toBe('${packageName}');`,
      '  });',
      '});',
      '',
    ].join('\n'),
  };
}

/** Compute every write without touching the tree. */
export function planPresenceScaffold(input: PresenceScaffoldInput): PresenceScaffoldPlan {
  try {
    return planScaffoldEdits(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('[CREATE_PRESENCE_ANCHOR]')) throw error;
    throw new Error(
      `${message} — nothing was changed | next: the root layout moved; update scripts/create_presence.ts, or register by hand (knowledge/product/governance/kyberion-development-practices.md)`
    );
  }
}

function planScaffoldEdits(input: PresenceScaffoldInput): PresenceScaffoldPlan {
  const root = input.rootDir ?? pathResolver.rootDir();
  const { group, name } = parsePresenceTarget(input.target);
  const packageId = `presence/${group}/${name}`;
  const packageName = `@presence/${name}`;
  const outDir = path.join(root, packageId);
  if (safeExistsSync(outDir))
    throw new Error(
      `[CREATE_PRESENCE_EXISTS] ${packageId} already exists — nothing was changed | next: pick another name, or register the existing package by hand`
    );
  // Two workspace packages with one name make `pnpm install` fail.
  const owner = (input.workspacePackages ?? collectWorkspacePackages()).find(
    (pkg) => pkg.name === packageName
  );
  if (owner)
    throw new Error(
      `[CREATE_PRESENCE_EXISTS] ${packageName} is already the name of ${owner.dir} — nothing was changed | next: pick another name`
    );
  const description = input.description?.trim() || `Kyberion presence package ${name}`;

  const updated: Record<string, string> = {};
  const unchanged: string[] = [];
  const stage = (file: string, next: string, original: string) => {
    if (next === original) unchanged.push(file);
    else updated[file] = next;
  };

  const rootTsconfig = read(root, 'tsconfig.json');
  stage(
    'tsconfig.json',
    editJson(rootTsconfig, (value) => {
      const exclude = (value.exclude ??= []) as string[];
      if (!exclude.includes(`${packageId}/`)) exclude.push(`${packageId}/`);
      addReference(value, `./${packageId}`);
    }),
    rootTsconfig
  );

  const packagesTsconfig = read(root, 'tsconfig.packages.json');
  stage(
    'tsconfig.packages.json',
    editJson(packagesTsconfig, (value) => addReference(value, `./${packageId}`)),
    packagesTsconfig
  );

  const layoutFile = 'scripts/build-output-layout.ts';
  const layout = read(root, layoutFile);
  let nextLayout = layout;
  if (!layout.includes(`id: '${packageId}'`)) {
    // Shaped like prettier prints the neighbouring entries (printWidth 100).
    nextLayout = insertBefore(
      nextLayout,
      layoutFile,
      '] as const;',
      [
        '  {',
        `    id: '${packageId}',`,
        `    sourceRoot: '${packageId}/src',`,
        '    excludeTests: true,',
        '  },',
      ].join('\n')
    );
  }
  if (!layout.includes(`'${group}/${name}',`)) {
    const marker = 'export const ROOT_SOURCE_EXCLUSIONS = {';
    const start = nextLayout.indexOf(marker);
    const close = start < 0 ? -1 : nextLayout.indexOf('\n  ],', start);
    if (close < 0)
      throw new Error(
        `[CREATE_PRESENCE_ANCHOR] ${layoutFile}: ROOT_SOURCE_EXCLUSIONS.presence not found`
      );
    nextLayout = `${nextLayout.slice(0, close)}\n    '${group}/${name}',${nextLayout.slice(close)}`;
  }
  stage(layoutFile, nextLayout, layout);

  for (const workflow of WORKFLOWS) {
    const source = read(root, workflow);
    const cacheLine = `${packageId}/dist/`;
    stage(
      workflow,
      source.split('\n').some((line) => line.trim() === cacheLine)
        ? source
        : insertBefore(source, workflow, 'plugins/dist/', cacheLine),
      source
    );
  }

  const i18nFile = 'knowledge/product/governance/i18n-baseline.json';
  const i18n = read(root, i18nFile);
  stage(
    i18nFile,
    editJson(i18n, (value) => {
      const roots = value.scan_roots as string[] | undefined;
      if (!Array.isArray(roots))
        throw new Error(`[CREATE_PRESENCE_ANCHOR] ${i18nFile}: scan_roots not found`);
      if (!roots.includes(packageId)) roots.push(packageId);
    }),
    i18n
  );

  return {
    packageId,
    packageName,
    outDir,
    created: packageFiles(packageId, packageName, description),
    updated,
    unchanged,
  };
}

export function nextSteps(packageId: string, packageName: string): string[] {
  return [
    `pnpm install (adds the ${packageName} importer to pnpm-lock.yaml)`,
    'Lockfile gate: write review evidence with the lockfile sha256, then run it with PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=<doc>',
    `pnpm --filter ${packageName} build (root tsc reads the package's dist types)`,
    `Only if the root imports it: add "${packageName}": "workspace:*" to the root package.json; for a command also add a script, a cli-commands.json entry with its vocabulary key, and raise MAX_PACKAGE_SCRIPTS in scripts/check/check_cli_manifest.ts`,
    'Describe it in docs/COMPONENT_MAP.md (and docs/SURFACES.md for an operator surface) and add a changelog.d fragment',
    `If its tests belong in a suite, add ${packageId}/ to TEST_SUITES in scripts/test_suite.ts; then run pnpm check -- --changed`,
  ];
}

/** Apply a plan. The dependency graph is regenerated only for the real repository. */
export function createPresenceScaffold(input: PresenceScaffoldInput): PresenceScaffoldResult {
  const plan = planPresenceScaffold(input);
  const root = input.rootDir ?? pathResolver.rootDir();
  for (const [file, content] of Object.entries(plan.created)) {
    const absolute = path.join(root, file);
    safeMkdir(path.dirname(absolute), { recursive: true });
    safeWriteFile(absolute, content);
  }
  for (const [file, content] of Object.entries(plan.updated)) {
    safeWriteFile(path.join(root, file), content);
  }
  const updated = Object.keys(plan.updated);
  if (input.rootDir === undefined) {
    safeWriteFile(path.join(root, GRAPH_FILE), renderDependencyGraph(collectWorkspacePackages()));
    updated.push(GRAPH_FILE);
  }
  return {
    packageId: plan.packageId,
    packageName: plan.packageName,
    created: Object.keys(plan.created),
    updated,
    unchanged: plan.unchanged,
    nextSteps: nextSteps(plan.packageId, plan.packageName),
  };
}

function parseCliArgs(args: string[]): PresenceScaffoldInput {
  const argv = createStandardYargs(['node', 'create_presence', ...args])
    .option('desc', { type: 'string', describe: 'One-line package description' })
    .parseSync();
  const target = argv._.map(String).filter(Boolean)[0];
  if (!target || target.startsWith('-'))
    throw new Error('Usage: pnpm kyberion create presence <displays|bridge>/<name> [--desc "…"]');
  return { target, description: typeof argv.desc === 'string' ? argv.desc : undefined };
}

export async function main(
  args: string[],
  options: { dryRun?: boolean; json?: boolean; print?: Print } = {}
): Promise<PresenceScaffoldResult | (PresenceScaffoldPlan & { mode: 'dry-run' })> {
  const input = parseCliArgs(args);
  const print = options.print ?? (() => undefined);
  if (options.dryRun) {
    const plan = planPresenceScaffold(input);
    if (!options.json) {
      print(`[create:presence] Dry run for ${plan.packageName} — nothing written. Would:`);
      for (const file of Object.keys(plan.created)) print(`  + ${file}`);
      for (const file of Object.keys(plan.updated)) print(`  ~ ${file}`);
      for (const file of plan.unchanged) print(`  = ${file} (already registered)`);
    }
    return { ...plan, mode: 'dry-run' };
  }
  const result = createPresenceScaffold(input);
  if (!options.json) {
    print(`[create:presence] Created ${result.packageName} at ${result.packageId}/`);
    for (const file of result.created) print(`  + ${file}`);
    for (const file of result.updated) print(`  ~ ${file}`);
    for (const file of result.unchanged) print(`  = ${file} (already registered)`);
    print('Next steps:');
    result.nextSteps.forEach((step, index) => print(`  ${index + 1}. ${step}`));
  }
  return result;
}

const script = defineScript({
  name: 'create:presence',
  flags: ['json', 'dry-run'],
  run: ({ argv, dryRun, json, print }) =>
    main(stripSharedScriptFlags(argv), { dryRun, json, print }).then((result) => {
      if (json) print(result);
      return result;
    }),
});
if (
  isDirectScript(import.meta.url, 'create_presence.ts') ||
  isDirectScript(import.meta.url, 'create_presence.js')
) {
  void script();
}
