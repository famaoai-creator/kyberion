/**
 * check_docs_drift.ts — CU-14: documentation drift gate.
 *
 *  1. every `pnpm <script>` / `pnpm run <x>` / `pnpm kyberion <cmd>` in the docs
 *     resolves to a package script, a deprecated alias (warning), an intended
 *     pnpm built-in, or a registered kyberion command (`pnpm doctor` is an
 *     explicit error: it is pnpm's own diagnostic, not Kyberion's);
 *  2. relative Markdown links resolve (delegates to check_documentation_links);
 *  3. every pipelines/*.json is listed in pipelines/README.md;
 *  4. docs/COMPONENT_MAP.md names every top-level directory;
 *  5. docs/CLI_REFERENCE.md matches the generator;
 *  6. `pnpm <script>` in *.service / *.plist / *.yml under docs/ and .github resolves like (1).
 *
 * Known exceptions live in knowledge/product/governance/docs-drift-baseline.json
 * (each with a reason). Stale baseline entries fail the gate so it only shrinks.
 */

import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { loadCliManifest, type CliManifest } from './check_cli_manifest.js';
import { checkDocumentationLinks } from './check_documentation_links.js';
import { readSafeJsonFile } from './lib/json-input.js';
import { renderCliReference } from './generate_cli_reference.js';
import { format as prettierFormat } from 'prettier';

const CLI_REFERENCE_FILE = 'docs/CLI_REFERENCE.md';
const DOC_ROOTS = ['docs', 'knowledge/product', 'knowledge/public'] as const;
const EXCLUDED_FRAGMENTS = [
  '/improvement-plans',
  '/docs/archive/',
  '/knowledge/public/external-wisdom/',
  '/node_modules/',
];
const EXCLUDED_FILES = new Set(['CHANGELOG.md']);
/** Config roots whose unit/plist/workflow files invoke `pnpm <script>` and rot when a script is renamed. */
const CONFIG_ROOTS = ['docs', '.github'] as const;
const CONFIG_EXTENSIONS = ['.service', '.plist', '.yml', '.yaml'] as const;

/** pnpm's own subcommands that docs may legitimately use. `doctor` is deliberately absent. */
export const PNPM_BUILTINS: ReadonlySet<string> = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'update',
  'up',
  'exec',
  'dlx',
  'run',
  'store',
  'why',
  'list',
  'ls',
  'outdated',
  'audit',
  'approve-builds',
  'rebuild',
  'prune',
  'fetch',
  'link',
  'pack',
  'publish',
  'config',
  'env',
  'create',
  'init',
  'patch',
  'patch-commit',
  'help',
  'dedupe',
  'import',
  'licenses',
  'self-update',
  'setup',
  // local bins resolved by pnpm when no script of that name exists
  'vitest',
  'tsx',
  'tsc',
  'prettier',
  'eslint',
]);
const EXPLAINS_PITFALL = /\bbare\b|built-in|組み込み|シャドウ|ではない|not Kyberion/iu;
const PNPM_ERRORS: Readonly<Record<string, string>> = {
  doctor:
    'bare `pnpm doctor` runs pnpm’s own diagnostic, not Kyberion’s — use `pnpm kyberion doctor` (or `pnpm run doctor`)',
};

export interface DocsDriftBaseline {
  /** key: `<rule>|<file>|<detail>` */
  exceptions: Array<{ key: string; reason: string }>;
}

export interface DocsDriftFinding {
  rule: 'command' | 'pipeline-catalog' | 'component-map' | 'cli-reference' | 'links';
  severity: 'error' | 'warn';
  file: string;
  detail: string;
}

export const findingKey = (finding: DocsDriftFinding): string =>
  `${finding.rule}|${finding.file.replace(/\\/gu, '/')}|${finding.detail}`;

export function isExcludedDocsDriftPath(file: string): boolean {
  const normalized = file.replace(/\\/gu, '/');
  return EXCLUDED_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isRegularFile(filePath: string): boolean {
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

export function docFiles(): string[] {
  const files: string[] = [];
  for (const root of DOC_ROOTS) {
    const abs = pathResolver.rootResolve(root);
    if (!safeExistsSync(abs)) continue;
    files.push(...getAllFiles(abs).filter((f) => f.endsWith('.md') && isRegularFile(f)));
  }
  for (const name of safeReaddir(pathResolver.rootDir())) {
    const abs = pathResolver.rootResolve(name);
    if (name.endsWith('.md') && !EXCLUDED_FILES.has(name) && isRegularFile(abs)) files.push(abs);
  }
  files.push(pathResolver.rootResolve('pipelines/README.md'));
  return [...new Set(files)].filter((f) => !isExcludedDocsDriftPath(f)).sort();
}

/** Service units, launchd plists and workflows under docs/ and .github that may run `pnpm <script>`. */
export function configFiles(): string[] {
  const files: string[] = [];
  for (const root of CONFIG_ROOTS) {
    const abs = pathResolver.rootResolve(root);
    if (!safeExistsSync(abs)) continue;
    files.push(
      ...getAllFiles(abs).filter(
        (f) =>
          CONFIG_EXTENSIONS.some((ext) => f.endsWith(ext)) &&
          !isExcludedDocsDriftPath(f) &&
          isRegularFile(f)
      )
    );
  }
  return [...new Set(files)].sort();
}

/**
 * Check `pnpm <script>` invocations in a non-Markdown config file (systemd unit,
 * launchd plist, workflow). The text is normalised so the Markdown-oriented
 * extractor sees plain command lines: absolute `/usr/bin/pnpm` paths collapse to
 * `pnpm` and plist `<string>` argument arrays collapse to one command line.
 */
export function checkConfigInvocations(
  relativeFile: string,
  text: string,
  index: CommandIndex
): DocsDriftFinding[] {
  const normalized = text
    .replace(/<\/string>\s*<string>/gu, ' ')
    .replace(/<\/?string>/gu, '')
    .replace(/[^\s"'=]*\/pnpm(?=\s)/gu, ' pnpm');
  return checkCommandInvocations(relativeFile, `\`\`\`\n${normalized}\n\`\`\``, index);
}

/** Code the docs show to a reader: fenced blocks (every line) and inline code spans. */
export interface CodeSnippet {
  text: string;
  /** the full source line the snippet came from (for context heuristics) */
  line: string;
}

export function extractCodeSnippets(markdown: string): CodeSnippet[] {
  const snippets: CodeSnippet[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // shell comments are prose, not commands
      if (!/^\s*#/u.test(line)) snippets.push({ text: line, line });
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/gu)) snippets.push({ text: match[1] ?? '', line });
  }
  return snippets;
}

export interface PnpmInvocation {
  kind: 'script' | 'kyberion';
  /** written as `pnpm run <name>` (bypasses pnpm built-ins) */
  viaRun?: boolean;
  /** script name, or the kyberion command words */
  name: string;
  words: string[];
}

const PLACEHOLDER = /[<>{}$*…\[\]"'`|\\]|^\.\.\.|^--?\w/u;

export function extractPnpmInvocations(snippet: string): PnpmInvocation[] {
  const results: PnpmInvocation[] = [];
  for (const match of snippet.matchAll(/(?:^|[\s(;&|])pnpm\s+([^\n]*)/gu)) {
    const tokens = (match[1] ?? '').split(/\s+/u).filter(Boolean);
    let head = tokens[0];
    if (!head || head.startsWith('-')) continue; // `pnpm -r ...`, `pnpm --filter ...`
    let rest = tokens.slice(1);
    let viaRun = false;
    if (head === 'run') {
      viaRun = true;
      head = rest[0];
      rest = rest.slice(1);
      if (!head || head.startsWith('-')) continue;
    }
    if (PLACEHOLDER.test(head) && !/^[A-Za-z][\w:.-]*$/u.test(head)) continue;
    if (/[<>{}$*…]/u.test(head)) continue;
    head = head.replace(/[.,;:)]+$/u, '');
    if (!head) continue;
    if (head === 'kyberion') {
      const words: string[] = [];
      for (const token of rest) {
        if (PLACEHOLDER.test(token) || token === '--') break;
        words.push(token.replace(/[.,;:)]+$/u, ''));
      }
      results.push({ kind: 'kyberion', name: words.join(' '), words });
    } else {
      results.push({ kind: 'script', name: head, words: [head], viaRun });
    }
  }
  return results;
}

export interface CommandIndex {
  scripts: Set<string>;
  scriptAliases: Map<string, string>;
  kyberion: Set<string>;
  kyberionAliases: Map<string, string>;
}

export function buildCommandIndex(
  manifest: CliManifest,
  packageScripts: Iterable<string>
): CommandIndex {
  const strip = (command: string) => command.replace(/ default$/u, '');
  const kyberion = new Set<string>();
  for (const entry of manifest.entrypoints)
    for (const command of entry.commands) kyberion.add(command);
  for (const command of manifest.commands) kyberion.add(strip(command.command));
  for (const command of manifest.script_commands ?? []) kyberion.add(strip(command.command));
  return {
    scripts: new Set(packageScripts),
    scriptAliases: new Map(
      (manifest.deprecated_script_aliases ?? []).map((a) => [a.script, a.replaced_by])
    ),
    kyberion,
    kyberionAliases: new Map(
      (manifest.deprecated_command_aliases ?? []).map((a) => [a.command, a.replaced_by])
    ),
  };
}

function kyberionResolves(index: CommandIndex, words: string[]): 'ok' | 'alias' | 'unknown' {
  if (words.length === 0) return 'ok';
  for (let n = words.length; n >= 1; n -= 1) {
    const candidate = words.slice(0, n).join(' ');
    if (index.kyberion.has(candidate)) return 'ok';
    if (index.kyberionAliases.has(candidate)) return 'alias';
  }
  return 'unknown';
}

export function checkCommandInvocations(
  relativeFile: string,
  markdown: string,
  index: CommandIndex
): DocsDriftFinding[] {
  const findings: DocsDriftFinding[] = [];
  const seen = new Set<string>();
  const push = (finding: DocsDriftFinding) => {
    const key = findingKey(finding);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const snippet of extractCodeSnippets(markdown)) {
    for (const invocation of extractPnpmInvocations(snippet.text)) {
      if (invocation.kind === 'script') {
        const name = invocation.name;
        if (PNPM_ERRORS[name] && !invocation.viaRun) {
          // a line that explains the pitfall is not an instruction to run it
          if (EXPLAINS_PITFALL.test(snippet.line)) continue;
          push({
            rule: 'command',
            severity: 'error',
            file: relativeFile,
            detail: `pnpm ${name}: ${PNPM_ERRORS[name]}`,
          });
        } else if (index.scripts.has(name)) {
          if (index.scriptAliases.has(name)) {
            push({
              rule: 'command',
              severity: 'warn',
              file: relativeFile,
              detail: `pnpm ${name} is a deprecated alias; use pnpm ${index.scriptAliases.get(name)}`,
            });
          }
        } else if (!PNPM_BUILTINS.has(name)) {
          push({
            rule: 'command',
            severity: 'error',
            file: relativeFile,
            detail: `pnpm ${name}: no such package script or pnpm built-in`,
          });
        }
      } else {
        const state = kyberionResolves(index, invocation.words);
        if (state === 'unknown') {
          push({
            rule: 'command',
            severity: 'error',
            file: relativeFile,
            detail: `pnpm kyberion ${invocation.name}: not a registered kyberion command`,
          });
        } else if (state === 'alias') {
          push({
            rule: 'command',
            severity: 'warn',
            file: relativeFile,
            detail: `pnpm kyberion ${invocation.name} is a deprecated command alias`,
          });
        }
      }
    }
  }
  return findings;
}

export function checkPipelineCatalog(
  pipelineNames: string[],
  readme: string,
  readmeFile = 'pipelines/README.md'
): DocsDriftFinding[] {
  return pipelineNames
    .filter((name) => !readme.includes(`\`${name}\``) && !readme.includes(`${name}.json`))
    .map((name) => ({
      rule: 'pipeline-catalog' as const,
      severity: 'error' as const,
      file: readmeFile,
      detail: `pipelines/${name}.json is not listed`,
    }));
}

export function checkComponentMap(
  topLevelDirs: string[],
  componentMap: string,
  file = 'docs/COMPONENT_MAP.md'
): DocsDriftFinding[] {
  const documented = componentMap
    .split('\n')
    .filter((line) => /^\|\s*`/u.test(line))
    .join(' ');
  return topLevelDirs
    .filter((dir) => !documented.includes(`\`${dir}/`))
    .map((dir) => ({
      rule: 'component-map' as const,
      severity: 'error' as const,
      file,
      detail: `top-level directory ${dir}/ is missing from the table`,
    }));
}

function gitignoredTopLevel(): Set<string> {
  const ignorePath = pathResolver.rootResolve('.gitignore');
  if (!safeExistsSync(ignorePath)) return new Set();
  const names = new Set<string>();
  for (const raw of readTextFile(ignorePath).split('\n')) {
    const line = raw.trim();
    const match = /^\/?([A-Za-z0-9_.-]+)\/$/u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export function topLevelDirectories(): string[] {
  const ignored = gitignoredTopLevel();
  return safeReaddir(pathResolver.rootDir())
    .filter((name) => name !== '.git' && name !== 'node_modules')
    .filter((name) => {
      try {
        return safeLstat(pathResolver.rootResolve(name)).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((name) => !ignored.has(name))
    .sort();
}

export async function checkCliReferenceFresh(
  manifest: CliManifest,
  current: string | null,
  file = 'docs/CLI_REFERENCE.md'
): Promise<DocsDriftFinding[]> {
  const expected = await prettierFormat(renderCliReference(manifest), {
    parser: 'markdown',
    singleQuote: true,
    printWidth: 100,
  });
  if (current === expected) return [];
  return [
    {
      rule: 'cli-reference',
      severity: 'error',
      file,
      detail:
        current === null
          ? 'missing; run pnpm generate:cli-reference'
          : 'stale; run pnpm generate:cli-reference',
    },
  ];
}

export function applyBaseline(
  findings: DocsDriftFinding[],
  baseline: DocsDriftBaseline
): { errors: DocsDriftFinding[]; warnings: DocsDriftFinding[]; staleBaseline: string[] } {
  const keys = new Map(baseline.exceptions.map((entry) => [entry.key, entry]));
  const used = new Set<string>();
  const errors: DocsDriftFinding[] = [];
  const warnings: DocsDriftFinding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    if (keys.has(key)) {
      used.add(key);
      continue;
    }
    (finding.severity === 'error' ? errors : warnings).push(finding);
  }
  return {
    errors,
    warnings,
    staleBaseline: [...keys.keys()].filter((key) => !used.has(key)),
  };
}

export async function collectDocsDrift(
  options: { skipLinks?: boolean } = {}
): Promise<DocsDriftFinding[]> {
  const root = pathResolver.rootDir();
  const manifest = loadCliManifest();
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    pathResolver.rootResolve('package.json'),
    'package.json'
  );
  const index = buildCommandIndex(manifest, Object.keys(packageJson.scripts ?? {}));
  const findings: DocsDriftFinding[] = [];
  for (const file of docFiles()) {
    // the generated reference lists deprecated aliases on purpose
    const relative = path.relative(root, file).replace(/\\/gu, '/');
    if (relative === CLI_REFERENCE_FILE) continue;
    findings.push(...checkCommandInvocations(relative, readTextFile(file), index));
  }
  for (const file of configFiles()) {
    findings.push(
      ...checkConfigInvocations(
        path.relative(root, file).replace(/\\/gu, '/'),
        readTextFile(file),
        index
      )
    );
  }
  const pipelineDir = pathResolver.rootResolve('pipelines');
  const names = safeReaddir(pipelineDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
  findings.push(
    ...checkPipelineCatalog(names, readTextFile(pathResolver.rootResolve('pipelines/README.md')))
  );
  findings.push(
    ...checkComponentMap(
      topLevelDirectories(),
      readTextFile(pathResolver.rootResolve('docs/COMPONENT_MAP.md'))
    )
  );
  const referencePath = pathResolver.rootResolve('docs/CLI_REFERENCE.md');
  findings.push(
    ...(await checkCliReferenceFresh(
      manifest,
      safeExistsSync(referencePath) ? readTextFile(referencePath) : null
    ))
  );
  if (!options.skipLinks) {
    for (const failure of checkDocumentationLinks()) {
      const [file, ...rest] = failure.split(': ');
      findings.push({
        rule: 'links',
        severity: 'error',
        file: (file ?? '').replace(/\\/gu, '/'),
        detail: rest.join(': '),
      });
    }
  }
  return findings;
}

export const BASELINE_PATH = 'knowledge/product/governance/docs-drift-baseline.json';

export const runCheckDocsDrift = defineScript({
  name: 'docs:check',
  async run(context) {
    const baseline = safeExistsSync(pathResolver.rootResolve(BASELINE_PATH))
      ? readSafeJsonFile<DocsDriftBaseline>(pathResolver.rootResolve(BASELINE_PATH), BASELINE_PATH)
      : { exceptions: [] };
    const findings = await collectDocsDrift({
      skipLinks: context.argv.includes('--skip-links'),
    });
    const { errors, warnings, staleBaseline } = applyBaseline(findings, baseline);
    for (const warning of warnings) context.print(`warn  ${warning.file}: ${warning.detail}`);
    if (errors.length > 0 || staleBaseline.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'docs drift detected:',
          ...errors.map((e) => `- [${e.rule}] ${e.file}: ${e.detail}`),
          ...staleBaseline.map((key) => `- stale baseline entry (remove it): ${key}`),
        ].join('\n')
      );
    }
    context.print(
      `[docs:check] OK (${warnings.length} warnings, ${baseline.exceptions.length} baselined)`
    );
    return { findings };
  },
});

if (
  isDirectScript(import.meta.url, 'check_docs_drift.ts') ||
  isDirectScript(import.meta.url, 'check_docs_drift.js')
)
  void runCheckDocsDrift();
