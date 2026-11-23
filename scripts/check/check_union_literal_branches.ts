/**
 * Union-literal branch gate: branching on a registry-backed string literal
 * (`x === 'literal'`) may only happen inside the module that owns the
 * registry, its union type or its canonical projection.
 *
 * Why: unions here are backed by registries (`WORKSPACE_KINDS`,
 * `CO_SESSION_PROVIDERS`, `CalendarSource`, …) with a single projection or
 * type-guard deciding what each member means. A new consumer branching on a
 * member literal bypasses that guard — the next member added silently does
 * the wrong thing. Route decisions through the projection (`isWorkspaceKind`,
 * `sourceGroup`, `CO_SESSION_PROVIDERS.includes`) or extend it.
 *
 * Literal sets are extracted from the source files themselves, so the gate
 * grows with the unions. Existing violations live in a shrink-only baseline
 * (`union-literal-branch-baseline.json`); new comparisons fail the gate.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { readTextFile, writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { resolveCiGateBaselinePath } from '../lib/ci/ci-gate-baseline.js';

export const GATE_ID = 'union-literal-branches';

/** Where each literal set is declared and how to extract it. */
interface LiteralSource {
  file: string;
  /**
   * `array`: `export const NAME = [...]`; `union`: `export type NAME = | 'a' | 'b'`;
   * `prop`: an inline property union `NAME: 'a' | 'b'` inside an interface.
   */
  kind: 'array' | 'union' | 'prop';
  name: string;
}

const LITERAL_SOURCES: LiteralSource[] = [
  {
    file: 'presence/displays/concierge/src/lib/workspace-view.ts',
    kind: 'array',
    name: 'WORKSPACE_KINDS',
  },
  {
    // Canonical declaration mirrored by WORKSPACE_KINDS above — the runtime
    // module that owns the union branches on it freely.
    file: 'libs/core/surface/workspace-graph.ts',
    kind: 'array',
    name: 'GRAPH_ENTITY_KINDS',
  },
  {
    file: 'libs/core/workforce/co-session.ts',
    kind: 'array',
    name: 'CO_SESSION_PROVIDERS',
  },
  {
    file: 'presence/displays/concierge/src/components/work-calendar/work-calendar.ts',
    kind: 'union',
    name: 'CalendarSource',
  },
  {
    file: 'presence/displays/concierge/src/components/work-calendar/work-calendar.ts',
    kind: 'array',
    name: 'CALENDAR_SOURCE_GROUPS',
  },
  {
    file: 'libs/core/surface/workspace-calendar.ts',
    kind: 'union',
    name: 'WorkspaceCalendarSource',
  },
  {
    file: 'libs/core/surface/workspace-calendar.ts',
    kind: 'prop',
    name: 'kind',
  },
  {
    file: 'presence/displays/concierge/src/components/work-calendar/work-calendar.ts',
    kind: 'prop',
    name: 'kind',
  },
];

/**
 * Extra files allowed to branch on these literals — canonical projections
 * outside the declaring module, with a one-line reason each. Empty by
 * design: a projection belongs inside the module that owns the union, so a
 * non-empty list is itself debt. Pre-existing comparisons live in the
 * baseline instead, which records them as shrink-only violations.
 */
const PROJECTION_ALLOWLIST: Record<string, string> = {};

/** Directories scanned for literal comparisons (repo-relative). */
const SCAN_DIRS = ['libs/core', 'scripts', 'presence/displays/concierge/src'];

const SKIP_DIR = new Set(['dist', 'node_modules', '.next', 'generated']);

/** Strip comments before reading literals — apostrophes in prose are not quotes. */
const stripComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, ' ');

function extractLiterals(source: LiteralSource, text: string): string[] {
  const pattern =
    source.kind === 'array'
      ? new RegExp(`export const ${source.name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`)
      : source.kind === 'union'
        ? new RegExp(`export type ${source.name}\\s*=\\s*([\\s\\S]*?);`)
        : new RegExp(`\\b${source.name}:\\s*((?:'[^']+'\\s*\\|\\s*)*'[^']+')`);
  const literals: string[] = [];
  for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
    literals.push(...[...stripComments(match[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]));
  }
  return [...new Set(literals)];
}

interface Violation {
  file: string;
  literal: string;
  lines: number[];
}

function* walk(dir: string): Generator<string> {
  if (!safeExistsSync(dir)) return;
  for (const entry of safeReaddir(dir)) {
    if (SKIP_DIR.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const stat = safeLstat(full);
    if (stat?.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts') && !entry.includes('.test.'))
      yield full;
  }
}

/**
 * Only discriminant comparisons count: `(kind|provider|source|sessionKind)
 * === '<lit>'` — the properties these registries describe. A bare
 * `x === 'task'` elsewhere is not this gate's concern.
 */
const compareRe = (literal: string) =>
  new RegExp(
    `(?:\\b(?:kind|provider|source|sessionKind)\\s*(?:===?|!==)\\s*['"]${literal}['"]|` +
      `['"]${literal}['"]\\s*===?\\s*\\w*(?:kind|provider|source|sessionKind)\\b)`
  );

function scanFile(repoFile: string, text: string, literals: Map<string, Set<string>>): Violation[] {
  const out = new Map<string, Set<number>>();
  const clean = stripComments(text);
  const lines = clean.split('\n');
  if (PROJECTION_ALLOWLIST[repoFile]) return [];
  for (const [literal, owners] of literals) {
    if (owners.has(repoFile)) continue; // declaring module owns it
    const re = compareRe(literal);
    lines.forEach((line, index) => {
      if (re.test(line)) {
        const set = out.get(literal) ?? new Set<number>();
        set.add(index + 1);
        out.set(literal, set);
      }
    });
  }
  return [...out].map(([literal, nums]) => ({
    file: repoFile,
    literal,
    lines: [...nums].sort((a, b) => a - b),
  }));
}

interface Baseline {
  version: 1;
  /** Shrink-only: `repo-relative file` → literals already known to branch there. */
  violations: Record<string, string[]>;
}

export function checkUnionLiteralBranches(
  root = pathResolver.rootResolve(''),
  options: { writeBaseline?: boolean } = {}
): { violations: Violation[]; unexpected: Violation[]; shrunk: string[] } {
  const literals = new Map<string, Set<string>>();
  for (const source of LITERAL_SOURCES) {
    const file = path.join(root, source.file);
    if (!safeExistsSync(file)) continue;
    for (const literal of extractLiterals(source, String(readTextFile(file)))) {
      const owners = literals.get(literal) ?? new Set<string>();
      owners.add(source.file);
      literals.set(literal, owners);
    }
  }

  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const text = String(readTextFile(file));
      const repoFile = path.relative(root, file).split(path.sep).join('/');
      violations.push(...scanFile(repoFile, text, literals));
    }
  }

  const baselinePath = resolveCiGateBaselinePath(GATE_ID);
  const baseline: Baseline = safeExistsSync(baselinePath)
    ? JSON.parse(String(readTextFile(baselinePath)))
    : { version: 1, violations: {} };

  if (options.writeBaseline) {
    const next: Baseline & { $schema?: string } = {
      $schema: '../schemas/union-literal-branch-baseline.schema.json',
      version: 1,
      violations: {},
    };
    for (const v of violations) {
      next.violations[v.file] = [
        ...new Set([...(next.violations[v.file] ?? []), v.literal]),
      ].sort();
    }
    withExecutionContext('ecosystem_architect', () => writeJson(baselinePath, next));
  }

  const unexpected = violations.filter(
    (v) => !(baseline.violations[v.file] ?? []).includes(v.literal)
  );
  const current = new Set(violations.map((v) => `${v.file}:${v.literal}`));
  const shrunk = Object.entries(baseline.violations).flatMap(([file, lits]) =>
    lits.filter((lit) => !current.has(`${file}:${lit}`)).map((lit) => `${file}:${lit}`)
  );
  return { violations, unexpected, shrunk };
}

export const runUnionLiteralBranches = defineScript({
  name: 'check-union-literal-branches',
  flags: [],
  run(context) {
    const writeBaseline = context.unknownFlags.includes('--write-baseline');
    const { violations, unexpected, shrunk } = checkUnionLiteralBranches(undefined, {
      writeBaseline,
    });
    if (writeBaseline) {
      context.print(`baseline written (${violations.length} known violations)`);
      return;
    }
    if (unexpected.length) {
      throw new ScriptExitError(
        1,
        [
          `union-literal-branches: ${unexpected.length} new literal comparison(s) outside the owning module:`,
          ...unexpected.map((v) => `  ${v.file}:${v.lines.join(',')} — '${v.literal}'`),
          'Route the decision through the canonical projection/guard, or extend',
          'it — do not branch on a registry literal in new code. If a comparison',
          'is genuinely canonical, add the file to PROJECTION_ALLOWLIST with a reason.',
        ].join('\n')
      );
    }
    context.print(
      `union-literal-branches: ok (${violations.length} baselined, ${shrunk.length} shrunk)`
    );
  },
});

if (
  isDirectScript(import.meta.url, 'check_union_literal_branches.ts') ||
  isDirectScript(import.meta.url, 'check_union_literal_branches.js')
)
  void runUnionLiteralBranches();
