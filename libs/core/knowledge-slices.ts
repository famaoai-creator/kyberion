/**
 * Knowledge Slices (KP-03).
 *
 * Task-profile-driven placement layer for knowledge provisioning. Loads and
 * validates `knowledge/product/governance/knowledge-slices.json` against
 * `knowledge/product/schemas/knowledge-slices.schema.json`, then resolves the
 * merged directives (`pinned` / `search_roots` / `exclude`) for a dispatch-time
 * task profile (`team_role` x `phase` x `mission_type`).
 *
 * Matcher precedence, merge semantics, and consumption order are specified in
 * `docs/developer/improvement-plans-2026-07/KP-03_SCHEMA_DESIGN_NOTE.ja.md`
 * (binding design answers — follow it, not ad hoc judgment, if this file and
 * that note ever disagree):
 *
 *  - specificity = count of non-wildcard `match` fields (0-3); same
 *    specificity ties break on array order, LATER entry wins.
 *  - `pinned` / `exclude` are UNIONED across every matching slice.
 *  - `pinned` order is most-specific-first, then de-duplicated keeping the
 *    first (= most specific) occurrence.
 *  - `search_roots` is MOST-SPECIFIC-WINS, not merged: the single most
 *    specific matching slice that declares `search_roots` supplies the whole
 *    list.
 *
 * `phase` is not currently threaded through from
 * `loadKnowledgeHintsIfPossible`'s production call site (design note open
 * question #1) — callers that omit it get `'*'`, which only satisfies
 * wildcard-phase slices. This is documented, expected fail-open behavior
 * until phase sourcing is wired, not a bug.
 *
 * Fail-open: a missing or schema-invalid manifest yields the same
 * `EMPTY_RESOLUTION` as "nothing matched" — callers must not distinguish
 * "no slices" from "slices file broken". A warning is logged once per
 * distinct manifest path on invalid/unreadable input.
 */

import AjvModule, { type ValidateFunction } from 'ajv';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

const SCHEMA_PATH = 'knowledge/product/schemas/knowledge-slices.schema.json';
const DEFAULT_DATA_PATH = 'knowledge/product/governance/knowledge-slices.json';

export interface KnowledgeSliceMatcher {
  team_role?: string;
  phase?: string;
  mission_type?: string;
}

export interface KnowledgeSliceDefinition {
  id?: string;
  description?: string;
  match: KnowledgeSliceMatcher;
  pinned?: string[];
  search_roots?: string[];
  exclude?: string[];
}

export interface KnowledgeSlicesFile {
  version: string;
  description?: string;
  slices: KnowledgeSliceDefinition[];
}

export interface ResolveKnowledgeSliceInput {
  /** Dispatch-time team role (e.g. 'implementer'). Omitted/blank is treated as '*'. */
  teamRole?: string;
  /**
   * Governance phase (alignment/execution/onboarding/recovery/review). Not
   * currently sourced by `loadKnowledgeHintsIfPossible`'s production call
   * site — see module doc. Omitted/blank is treated as '*'.
   */
  phase?: string;
  /** Dispatch-time mission type. Omitted/blank is treated as '*'. */
  missionType?: string;
  /**
   * Test-only override for the slices manifest path (repo-relative).
   * Defaults to `knowledge/product/governance/knowledge-slices.json`.
   */
  slicesPath?: string;
}

export interface ResolvedKnowledgeSlice {
  /** Repo-relative paths to always-deliver documents, most-specific-first, de-duplicated. */
  pinned: string[];
  /**
   * Repo-relative subtree prefixes (trailing '/') to prioritise during search.
   * Supplied by the single most-specific matching slice that declares any;
   * empty when no matching slice declares `search_roots`.
   */
  searchRoots: string[];
  /** Repo-relative globs that must never be delivered (unioned across all matching slices). */
  exclude: string[];
  /** Diagnostic only: ids (or `#index` fallback) of matched slices, most-specific-first. */
  matchedSliceIds: string[];
}

const EMPTY_RESOLUTION: ResolvedKnowledgeSlice = Object.freeze({
  pinned: [],
  searchRoots: [],
  exclude: [],
  matchedSliceIds: [],
}) as ResolvedKnowledgeSlice;

let cachedValidator: ValidateFunction | null | undefined;

function getValidator(): ValidateFunction | null {
  if (cachedValidator !== undefined) return cachedValidator;
  try {
    const raw = safeReadFile(pathResolver.rootResolve(SCHEMA_PATH), { encoding: 'utf8' }) as string;
    const schema = JSON.parse(raw);
    const ajv = new Ajv({ allErrors: true });
    cachedValidator = ajv.compile(schema);
  } catch {
    cachedValidator = null;
  }
  return cachedValidator;
}

const fileCache = new Map<string, KnowledgeSlicesFile | null>();
const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * Load and validate the knowledge slices manifest. Never throws: returns
 * `null` when the file is missing, unreadable, unparsable, or schema-invalid.
 * Result is cached per manifest path (module lifetime) — see
 * `_resetKnowledgeSlicesCacheForTests`.
 */
export function loadKnowledgeSlicesFile(
  dataPath: string = DEFAULT_DATA_PATH
): KnowledgeSlicesFile | null {
  if (fileCache.has(dataPath)) return fileCache.get(dataPath)!;

  let result: KnowledgeSlicesFile | null = null;
  try {
    const abs = pathResolver.rootResolve(dataPath);
    if (!safeExistsSync(abs)) {
      fileCache.set(dataPath, null);
      return null;
    }
    const raw = safeReadFile(abs, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw);
    const validate = getValidator();
    if (validate && !validate(parsed)) {
      warnOnce(
        `invalid:${dataPath}`,
        `[knowledge-slices] ${dataPath} failed schema validation; ignoring slice directives (fail-open). ${
          validate.errors ? JSON.stringify(validate.errors) : ''
        }`
      );
      fileCache.set(dataPath, null);
      return null;
    }
    result = parsed as KnowledgeSlicesFile;
  } catch (error) {
    warnOnce(
      `error:${dataPath}`,
      `[knowledge-slices] failed to load ${dataPath}; ignoring slice directives (fail-open). ${
        (error as Error)?.message || String(error)
      }`
    );
    result = null;
  }
  fileCache.set(dataPath, result);
  return result;
}

/**
 * Test-only: clear the module-level manifest cache and warn-once log so a
 * fixture written at a reused path is re-read on the next resolution.
 */
export function _resetKnowledgeSlicesCacheForTests(): void {
  fileCache.clear();
  warnedKeys.clear();
}

function normalizeToken(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed || '*';
}

function matcherSpecificity(match: KnowledgeSliceMatcher | undefined): number {
  if (!match) return 0;
  return (['team_role', 'phase', 'mission_type'] as const).filter(
    (key) => match[key] !== undefined && match[key] !== '*'
  ).length;
}

function sliceMatches(
  match: KnowledgeSliceMatcher | undefined,
  request: { team_role: string; phase: string; mission_type: string }
): boolean {
  if (!match) return true;
  for (const key of ['team_role', 'phase', 'mission_type'] as const) {
    const declared = match[key];
    if (declared === undefined || declared === '*') continue;
    if (declared !== request[key]) return false;
  }
  return true;
}

/**
 * Resolve the merged slice directives for a dispatch-time task profile. See
 * the module doc / KP-03 design note for precedence and merge rules. Never
 * throws; returns an empty resolution when the manifest is missing/invalid
 * or no declared slice matches the profile.
 */
export function resolveKnowledgeSlice(input: ResolveKnowledgeSliceInput): ResolvedKnowledgeSlice {
  const file = loadKnowledgeSlicesFile(input.slicesPath);
  if (!file || !Array.isArray(file.slices) || file.slices.length === 0) return EMPTY_RESOLUTION;

  const request = {
    team_role: normalizeToken(input.teamRole),
    phase: normalizeToken(input.phase),
    mission_type: normalizeToken(input.missionType),
  };

  const matched = file.slices
    .map((slice, index) => ({ slice, index, specificity: matcherSpecificity(slice.match) }))
    .filter((entry) => sliceMatches(entry.slice.match, request));

  if (matched.length === 0) return EMPTY_RESOLUTION;

  // Most-specific-first; same specificity => later array entry wins (design note precedence rule).
  const sorted = [...matched].sort((a, b) =>
    b.specificity !== a.specificity ? b.specificity - a.specificity : b.index - a.index
  );

  const pinnedOrdered: string[] = [];
  for (const entry of sorted) {
    for (const p of entry.slice.pinned ?? []) pinnedOrdered.push(p);
  }
  const seenPinned = new Set<string>();
  const pinned = pinnedOrdered.filter((p) => {
    if (seenPinned.has(p)) return false;
    seenPinned.add(p);
    return true;
  });

  const excludeSet = new Set<string>();
  for (const entry of matched) {
    for (const g of entry.slice.exclude ?? []) excludeSet.add(g);
  }

  let searchRoots: string[] = [];
  for (const entry of sorted) {
    if (entry.slice.search_roots && entry.slice.search_roots.length > 0) {
      searchRoots = entry.slice.search_roots.slice();
      break;
    }
  }

  return {
    pinned,
    searchRoots,
    exclude: Array.from(excludeSet),
    matchedSliceIds: sorted.map((entry) => entry.slice.id || `#${entry.index}`),
  };
}

// ── Minimal glob matcher for `exclude` (single-path-segment '*' wildcard) ──
//
// No repo dependency provides glob matching (checked package.json: no
// minimatch/micromatch/picomatch/fast-glob). The schema deliberately keeps
// `exclude` globs simple — '*' matches within one path segment, never across
// '/' — so a hand-rolled matcher avoids adding a dependency for this.

const globRegexCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = globRegexCache.get(glob);
  if (cached) return cached;
  const pattern = glob
    .split('*')
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  const re = new RegExp(`^${pattern}$`);
  globRegexCache.set(glob, re);
  return re;
}

/** True if `repoRelativePath` matches the given `exclude`-style glob. */
export function matchesKnowledgeGlob(repoRelativePath: string, glob: string): boolean {
  return globToRegExp(glob).test(repoRelativePath);
}

/** True if `repoRelativePath` matches any of `globs` (empty list => never excluded). */
export function isKnowledgePathExcluded(repoRelativePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesKnowledgeGlob(repoRelativePath, glob));
}

/** True if `repoRelativePath` falls under any of `roots` (repo-relative subtree prefixes). */
export function isKnowledgePathInSearchRoots(repoRelativePath: string, roots: string[]): boolean {
  return roots.some((root) => repoRelativePath.startsWith(root));
}
