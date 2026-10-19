/**
 * `pnpm check -- --changed` gate selection (dev-cycle plan S1/M1).
 *
 * CI runs `--scope full`; a local `--scope pr` run misses the full-only gates
 * (op-registry, governance-rules, catalogs, ...). Each full/release gate may
 * declare `paths` (repo-relative globs of the inputs it reads) in
 * `knowledge/product/governance/ci-gates.json`; `--changed` runs every `pr`
 * gate plus each full/release gate whose `paths` match a changed file.
 *
 * Pure functions only: git access lives in `run_checks.ts`.
 */

export interface PathTriggeredGate {
  id: string;
  scope: 'pr' | 'full' | 'release';
  paths?: string[];
}

export interface ChangedGateMatch {
  id: string;
  scope: 'full' | 'release';
  /** Every changed file that matched, with the first pattern that matched it. */
  matches: Array<{ file: string; pattern: string }>;
}

export interface ChangedGateSelection<G extends PathTriggeredGate> {
  gates: G[];
  extra: ChangedGateMatch[];
}

const globCache = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

/** Expand one level of `{a,b}` alternation; nesting is rejected by the manifest validator. */
function globBodyToPattern(glob: string): string {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          // `**/` matches zero or more whole directories.
          index += 1;
          pattern += '(?:[^/]+/)*';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', index);
      if (close === -1) throw new Error(`unterminated "{" in glob: ${glob}`);
      const options = glob.slice(index + 1, close).split(',');
      pattern += `(?:${options.map((option) => globBodyToPattern(option)).join('|')})`;
      index = close;
    } else {
      pattern += escapeRegExp(char);
    }
  }
  return pattern;
}

/**
 * Minimal, dependency-free glob matcher for repo-relative POSIX paths:
 * `*` and `?` stay within one path segment, `**` crosses segments
 * (`dir/**` matches everything below `dir`), and `{a,b}` alternates.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const regex = new RegExp(`^${globBodyToPattern(glob)}$`);
  globCache.set(glob, regex);
  return regex;
}

export function normalizeChangedPath(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function matchesGatePath(file: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizeChangedPath(file));
}

/** Returns validation errors for a gate's `paths` (empty = valid). */
export function validateGatePaths(gate: PathTriggeredGate): string[] {
  if (gate.paths === undefined) return [];
  const errors: string[] = [];
  if (!Array.isArray(gate.paths) || gate.paths.length === 0) {
    return [`ci gate ${gate.id} paths must be a non-empty array of glob strings`];
  }
  if (gate.scope === 'pr') {
    errors.push(`ci gate ${gate.id} declares paths but pr gates always run under --changed`);
  }
  for (const pattern of gate.paths) {
    if (typeof pattern !== 'string' || !pattern.trim()) {
      errors.push(`ci gate ${gate.id} paths entries must be non-empty strings`);
      continue;
    }
    if (pattern.startsWith('/') || pattern.startsWith('./') || pattern.split('/').includes('..')) {
      errors.push(`ci gate ${gate.id} path ${pattern} must be repo-relative`);
    }
    if (/\{[^}]*\{/.test(pattern)) {
      errors.push(`ci gate ${gate.id} path ${pattern} may not nest "{...}" groups`);
    }
    try {
      globToRegExp(pattern);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

/**
 * Every `pr` gate, plus every full/release gate whose `paths` match at least
 * one changed file. Manifest order is preserved; gates without `paths` are
 * never selected by a change (they still run under `--scope full`).
 */
export function selectChangedGates<G extends PathTriggeredGate>(
  gates: readonly G[],
  changedFiles: readonly string[]
): ChangedGateSelection<G> {
  const files = [...new Set(changedFiles.map(normalizeChangedPath).filter(Boolean))].sort();
  const selected: G[] = [];
  const extra: ChangedGateMatch[] = [];
  for (const gate of gates) {
    if (gate.scope === 'pr') {
      selected.push(gate);
      continue;
    }
    if (!gate.paths?.length) continue;
    const matches: ChangedGateMatch['matches'] = [];
    for (const file of files) {
      const pattern = gate.paths.find((candidate) => globToRegExp(candidate).test(file));
      if (pattern) matches.push({ file, pattern });
    }
    if (matches.length > 0) {
      selected.push(gate);
      extra.push({ id: gate.id, scope: gate.scope, matches });
    }
  }
  return { gates: selected, extra };
}

/** One human-readable line per path-selected gate. */
export function describeChangedGateMatch(match: ChangedGateMatch): string {
  const [first] = match.matches;
  const more = match.matches.length > 1 ? ` (+${match.matches.length - 1} more)` : '';
  return `+ ${match.id} [${match.scope}] ← ${first!.file} matches ${first!.pattern}${more}`;
}
