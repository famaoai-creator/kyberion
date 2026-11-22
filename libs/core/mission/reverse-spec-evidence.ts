/**
 * Structural proof for the reverse_spec workflow gates.
 *
 * Design source: Reverse Spec Flow (aws-samples/sample-reverse-spec-flow) —
 * a code-graph denominator counted mechanically, path:line citations that must
 * resolve in the frozen source, explicit UNKNOWN instead of guesses, an
 * independent verifier, and a source-intact fingerprint. Completion is decided
 * by these checks, never by an agent's own "done".
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/primitives.js';
import { findMissionPath } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeStat } from '../secure-io.js';
import { streamJsonLines } from '../storage/jsonl-read.js';
import {
  DEFAULT_SOURCE_TREE_MAX_FILES,
  computeSourceFingerprint,
  listSourceTreeFiles,
  resolveWorkspaceSourceRoot,
  type ResolvedSourceRoot,
} from '../analysis/source-fingerprint.js';
import {
  codeGraphLanguageFor,
  loadCodeGraphEnumerationRules,
  SOURCE_LIKE_EXTENSIONS,
} from '../analysis/code-graph-rules.js';

export const REVERSE_SPEC_EVIDENCE_STAGES = [
  'scope',
  'code_graph',
  'analysis',
  'specify',
  'audit',
] as const;
export type ReverseSpecEvidenceStage = (typeof REVERSE_SPEC_EVIDENCE_STAGES)[number];

export const REVERSE_SPEC_PURPOSES = ['maintenance', 'evaluation', 'rebuild'] as const;
export type ReverseSpecPurpose = (typeof REVERSE_SPEC_PURPOSES)[number];

export const REVERSE_SPEC_ANALYSIS_CATEGORIES = [
  'ARCH',
  'REQ',
  'API',
  'DATA',
  'BEHAVIOR',
  'NFR',
] as const;
export const REVERSE_SPEC_NODE_KINDS = ['module', 'entrypoint', 'boundary'] as const;
export const REVERSE_SPEC_CONFIDENCE = ['confirmed', 'inferred', 'unknown'] as const;
export const REVERSE_SPEC_UNKNOWN_CLASSES = [
  'blocking',
  'deferred',
  'out_of_scope',
  'undecidable',
  'partial',
] as const;
export const REVERSE_SPEC_VERDICTS = ['supported', 'partial', 'unsupported', 'fabricated'] as const;
/** Smallest random sample accepted for non-rebuild purposes (or the whole population if smaller). */
export const REVERSE_SPEC_MIN_SAMPLE = 30;

/** Ledger task-id suffixes whose recorded actors author and independently verify the specs. */
export const REVERSE_SPEC_AUTHOR_TASK_SUFFIX = 'specify';
export const REVERSE_SPEC_VERIFIER_TASK_SUFFIX = 'independent-verify';
/** Decision record a denominator disposition must reference (schema: reverse-spec-decision-record). */
export const REVERSE_SPEC_DECISION_RECORD_FIELDS = [
  'decision_id',
  'decision',
  'reason',
  'decided_by',
  'decided_at',
  'affected_node_ids',
] as const;

export const REVERSE_SPEC_EVIDENCE_FILES = {
  scope: 'evidence/reverse-spec-scope.json',
  code_graph: 'evidence/code-graph.json',
  analysis: 'evidence/analysis-ledger.json',
  specify: 'evidence/spec-ledger.json',
  audit: 'evidence/verification-ledger.json',
} as const satisfies Record<ReverseSpecEvidenceStage, string>;

const SPEC_ID_PATTERN = /^SPEC-[A-Z]+-[A-Za-z0-9][A-Za-z0-9-]*-\d{2,}$/u;
const ANALYSIS_ID_PATTERN = /^ANA-(ARCH|REQ|API|DATA|BEHAVIOR|NFR)-[A-Za-z0-9-]+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/u;
const MAX_LISTED = 12;

export interface ReverseSpecEvidenceResult {
  stage: ReverseSpecEvidenceStage;
  path: string;
  ok: true;
  summary: Record<string, number | string>;
}

/** Collected stage failure: one diagnostic line per problem, capped in the message. */
export class ReverseSpecEvidenceError extends Error {
  readonly problems: string[];
  constructor(stage: string, evidencePath: string, problems: string[]) {
    const listed = problems.slice(0, MAX_LISTED).map((problem) => `  - ${problem}`);
    if (problems.length > MAX_LISTED) listed.push(`  - … and ${problems.length - MAX_LISTED} more`);
    super(
      `[REVERSE_SPEC_EVIDENCE] ${stage} evidence invalid — ${problems.length} problem(s) | next: fix the listed items and re-run the gate | evidence: ${evidencePath}\n${listed.join('\n')}`
    );
    this.name = 'ReverseSpecEvidenceError';
    this.problems = problems;
  }
}

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`[REVERSE_SPEC_EVIDENCE] ${message}`);
}

function readJsonEvidence(missionDir: string, relative: string): Json {
  const abs = path.join(missionDir, relative);
  if (!safeExistsSync(abs) || !safeStat(abs).isFile()) {
    fail(
      `missing ${relative} — the stage deliverable has not been written | next: produce ${relative}`
    );
  }
  return parseSafeJsonObjectInput(String(safeReadFile(abs, { encoding: 'utf8' })), relative);
}

/** True when `relative` names a regular file inside the mission directory (no traversal out). */
function missionFileExists(missionDir: string, relative: string): boolean {
  const abs = path.resolve(missionDir, relative);
  return (
    abs.startsWith(path.resolve(missionDir) + path.sep) &&
    safeExistsSync(abs) &&
    safeStat(abs).isFile()
  );
}

function graphFileCount(missionDir: string): number | undefined {
  const abs = path.join(missionDir, REVERSE_SPEC_EVIDENCE_FILES.code_graph);
  if (!safeExistsSync(abs)) return undefined;
  try {
    const graph = parseSafeJsonObjectInput(
      String(safeReadFile(abs, { encoding: 'utf8' })),
      'code-graph'
    );
    const count = isRecord(graph.source_fingerprint)
      ? graph.source_fingerprint.file_count
      : undefined;
    return typeof count === 'number' && Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function capList(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  return ids.length > MAX_LISTED ? `${shown} … (+${ids.length - MAX_LISTED})` : shown;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * Problem text if the decision record at `relative` does not justify disposing `nodeId`
 * with `status`, else null. Shape: knowledge/product/schemas/reverse-spec-decision-record.schema.json.
 */
function checkDecisionRecord(
  missionDir: string,
  relative: string,
  nodeId: string,
  status: unknown
): string | null {
  if (!relative.endsWith('.json'))
    return `decision_ref ${relative} must be a JSON decision record (${REVERSE_SPEC_DECISION_RECORD_FIELDS.join(', ')})`;
  let record: Json;
  try {
    record = parseSafeJsonObjectInput(
      String(safeReadFile(path.resolve(missionDir, relative), { encoding: 'utf8' })),
      relative
    );
  } catch (error) {
    return `decision_ref ${relative} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const missing = REVERSE_SPEC_DECISION_RECORD_FIELDS.filter((field) =>
    field === 'affected_node_ids' ? !Array.isArray(record[field]) : !nonEmpty(record[field])
  );
  if (missing.length) return `decision record ${relative} missing ${missing.join(', ')}`;
  if (record.decision !== status)
    return `decision record ${relative} decides ${String(record.decision)}, but the disposition says ${String(status)}`;
  if (!ISO_TIMESTAMP_PATTERN.test(String(record.decided_at)))
    return `decision record ${relative} decided_at must be an ISO-8601 timestamp`;
  if (!stringList(record.affected_node_ids).includes(nodeId))
    return `decision record ${relative} does not list ${nodeId} in affected_node_ids`;
  return null;
}

/** Actors recorded in the mission execution ledger for tasks whose id ends with `-<suffix>`. */
function ledgerTaskActors(missionDir: string, suffix: string): Set<string> {
  const actors = new Set<string>();
  const abs = path.join(missionDir, 'execution-ledger.jsonl');
  if (!safeExistsSync(abs)) return actors;
  // Append-only ledger: stream it, and skip a malformed line rather than hide the rest.
  for (const entry of streamJsonLines<unknown>(abs, { onMalformed: 'skip' })) {
    if (!isRecord(entry) || entry.event_type !== 'evidence_recorded') continue;
    const taskId = String(entry.task_id ?? '');
    if ((taskId === suffix || taskId.endsWith(`-${suffix}`)) && nonEmpty(entry.actor_id))
      actors.add(entry.actor_id.trim());
  }
  return actors;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON with object keys sorted, so formatting and key order do not change a hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * Sampling seed: the hash of the spec ledger's canonical JSON, so neither the author nor the
 * verifier picks it and reformatting the file cannot re-roll it.
 */
function auditSamplingSeed(missionDir: string): string {
  return sha256Hex(
    canonicalJson(readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.specify))
  );
}

/** Deterministic random sample of confirmed claims: ordered by sha256(seed \0 claim_id). */
export function selectReverseSpecAuditSample(
  confirmedClaimIds: readonly string[],
  seed: string,
  size: number
): string[] {
  return [...confirmedClaimIds]
    .map((id) => ({ id, rank: sha256Hex(`${seed}\0${id}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, Math.max(0, size))
    .map((entry) => entry.id);
}

/** Reads source files once per validation; line counts are cached per path. */
class SourceView {
  private readonly lineCounts = new Map<string, number | null>();
  private listed: Set<string> | undefined;
  constructor(
    readonly root: ResolvedSourceRoot,
    private readonly maxFiles = DEFAULT_SOURCE_TREE_MAX_FILES
  ) {}

  /** Files the fingerprint covers; citations outside it (symlinks, skipped secrets) do not resolve. */
  files(): Set<string> {
    this.listed ??= new Set(listSourceTreeFiles(this.root.absolute, { maxFiles: this.maxFiles }));
    return this.listed;
  }

  /** Line count of a source-relative file, or null if it is not a readable file inside the root. */
  lineCount(relative: string): number | null {
    if (this.lineCounts.has(relative)) return this.lineCounts.get(relative) ?? null;
    let count: number | null = null;
    const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
    if (this.files().has(normalized)) {
      const abs = path.join(this.root.absolute, normalized);
      try {
        if (safeExistsSync(abs) && safeStat(abs).isFile()) {
          const text = String(safeReadFile(abs, { encoding: 'utf8', maxSizeMB: 64 }));
          count = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        }
      } catch {
        count = null;
      }
    }
    this.lineCounts.set(relative, count);
    return count;
  }

  /**
   * Problem text if `path:line` does not resolve, else null. `allowEmptyFile`
   * accepts line 1 of an empty file — a node location (a module is its file),
   * never a claim citation, which must point at real content.
   */
  checkCitation(citation: Json, options: { allowEmptyFile?: boolean } = {}): string | null {
    const file = citation.path;
    const line = citation.line;
    if (!nonEmpty(file)) return 'citation without path';
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
      return `citation ${file} has no positive integer line`;
    const count = this.lineCount(file);
    if (count === null)
      return `citation ${file}:${line} does not resolve to a file in the source root`;
    if (line > count && !(options.allowEmptyFile && count === 0 && line === 1))
      return `citation ${file}:${line} is beyond the end of the file (${count} lines)`;
    return null;
  }
}

function loadScope(
  missionDir: string,
  maxFiles?: number
): {
  scope: Json;
  purpose: ReverseSpecPurpose;
  source: SourceView;
} {
  const scope = readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.scope);
  if (!nonEmpty(scope.source_root))
    fail(
      `reverse-spec-scope.json has no source_root — why: the gate cannot locate the analyzed source | next: set source_root to the copied target (active/shared/staging/<job>/) | evidence: ${REVERSE_SPEC_EVIDENCE_FILES.scope}`
    );
  const purpose = scope.purpose;
  if (!(REVERSE_SPEC_PURPOSES as readonly unknown[]).includes(purpose))
    fail(
      `reverse-spec-scope.json purpose is invalid — why: got ${String(purpose)} | next: set purpose to one of ${REVERSE_SPEC_PURPOSES.join('|')} | evidence: ${REVERSE_SPEC_EVIDENCE_FILES.scope}`
    );
  return {
    scope,
    purpose: purpose as ReverseSpecPurpose,
    source: new SourceView(resolveWorkspaceSourceRoot(scope.source_root), maxFiles),
  };
}

function validateScope(missionDir: string): Record<string, number | string> {
  const { scope, purpose, source } = loadScope(missionDir);
  const problems: string[] = [];
  const commit = scope.baseline_commit;
  if (
    !(typeof commit === 'string' && COMMIT_PATTERN.test(commit)) &&
    !nonEmpty(scope.baseline_note)
  )
    problems.push('baseline_commit (hex sha) or baseline_note (why no VCS baseline) required');
  if (stringList(scope.in_scope).length < 1)
    problems.push('in_scope must list at least one path or area');
  if (!Array.isArray(scope.exclusions)) problems.push('exclusions must be an array (may be empty)');
  for (const [index, exclusion] of records(scope.exclusions).entries()) {
    if (!nonEmpty(exclusion.path) || !nonEmpty(exclusion.reason))
      problems.push(`exclusions[${index}] needs path and reason`);
  }
  if (scope.uncovered_extensions !== undefined && !Array.isArray(scope.uncovered_extensions))
    problems.push('uncovered_extensions must be an array of {extension, reason}');
  for (const [index, entry] of records(scope.uncovered_extensions).entries()) {
    if (!nonEmpty(entry.extension) || !nonEmpty(entry.reason))
      problems.push(`uncovered_extensions[${index}] needs extension and reason`);
  }
  if (!Array.isArray(scope.references)) problems.push('references must be an array (may be empty)');
  for (const reference of records(scope.references)) {
    if (reference.status !== 'unverified_claim')
      problems.push(
        `reference ${String(reference.path)} must be status unverified_claim — existing documents are claims until code confirms them`
      );
  }
  if (problems.length)
    throw new ReverseSpecEvidenceError('scope', REVERSE_SPEC_EVIDENCE_FILES.scope, problems);
  return { purpose, source_root: source.root.relative };
}

interface CodeGraph {
  nodeIds: Set<string>;
  fingerprint: string;
  fileCount: number;
}

/** Element key a reconciliation row lists for a node (modules by file; markers by subtype@path:line). */
function reconciliationKey(node: Json): string {
  return node.kind === 'module'
    ? String(node.path ?? '')
    : `${String(node.subtype ?? '')}@${String(node.path ?? '')}:${String(node.line ?? '')}`;
}

function sameSet(listed: string[], expected: Set<string>): boolean {
  return listed.length === expected.size && listed.every((entry) => expected.has(entry));
}

/**
 * Re-derive the module denominator from the source tree with the governed rules, so the graph
 * cannot shrink it by omission: every non-excluded file a requested rule language covers needs a
 * `MOD:<file>` node, and every other source-like file (or file of a filtered-out rule language)
 * needs its extension declared in the scope's uncovered_extensions.
 */
function deriveDenominatorProblems(
  graph: Json,
  source: SourceView,
  nodeIds: Set<string>,
  uncoveredExtensions: string[]
): string[] {
  const problems: string[] = [];
  const rules = loadCodeGraphEnumerationRules().languages;
  const generatedBy = isRecord(graph.generated_by) ? graph.generated_by : {};
  const requested = stringList(generatedBy.languages);
  const unknown = requested.filter((id) => !rules.some((rule) => rule.id === id));
  if (unknown.length)
    problems.push(`generated_by.languages names unknown rules: ${capList(unknown)}`);
  const active = requested.length ? rules.filter((rule) => requested.includes(rule.id)) : rules;
  const inactive = rules.filter((rule) => !active.includes(rule));
  const excluded = stringList(graph.excluded_paths).map((entry) =>
    path.posix.normalize(entry).replace(/\/$/u, '')
  );
  const missing: string[] = [];
  const undeclared = new Set<string>();
  for (const file of source.files()) {
    if (excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) continue;
    if (codeGraphLanguageFor(file, active)) {
      if (!nodeIds.has(`MOD:${file}`)) missing.push(file);
      continue;
    }
    const ext = path.posix.extname(file).toLowerCase();
    if (
      (SOURCE_LIKE_EXTENSIONS.has(ext) || codeGraphLanguageFor(file, inactive)) &&
      !uncoveredExtensions.includes(ext)
    )
      undeclared.add(ext);
  }
  if (missing.length)
    problems.push(
      `${missing.length} source file(s) covered by the rules have no MOD: node — the denominator was shrunk by omission: ${capList(missing)}`
    );
  if (undeclared.size)
    problems.push(
      `source extensions no rule analyzed, not declared in reverse-spec-scope.json uncovered_extensions: ${capList([...undeclared].sort())}`
    );
  return problems;
}

function validateCodeGraphDocument(
  missionDir: string,
  source: SourceView,
  declared: { exclusions: string[]; uncoveredExtensions: string[] }
): CodeGraph {
  const graph = readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.code_graph);
  const problems: string[] = [];
  if (graph.kind !== 'code-graph-registry') problems.push("kind must be 'code-graph-registry'");
  const fingerprint = isRecord(graph.source_fingerprint) ? graph.source_fingerprint : {};
  if (fingerprint.algorithm !== 'sha256' || !nonEmpty(fingerprint.value))
    problems.push('source_fingerprint {algorithm: sha256, value} required');
  if (
    nonEmpty(graph.source_root) &&
    path.posix.normalize(graph.source_root) !== path.posix.normalize(source.root.relative)
  )
    problems.push(
      `source_root ${graph.source_root} differs from the scope's ${source.root.relative}`
    );
  // Paths left out of the graph shrink the denominator: each must be a scope exclusion with a reason.
  const undeclared = stringList(graph.excluded_paths).filter(
    (excluded) => !declared.exclusions.includes(path.posix.normalize(excluded).replace(/\/$/u, ''))
  );
  if (undeclared.length)
    problems.push(
      `excluded_paths not declared in reverse-spec-scope.json exclusions: ${capList(undeclared)}`
    );
  const nodes = records(graph.nodes);
  if (nodes.length === 0)
    problems.push('nodes must be non-empty — the denominator cannot be empty');
  const ids = nodes.map((node) => String(node.id ?? ''));
  const dup = duplicates(ids);
  if (dup.length) problems.push(`duplicate node ids: ${capList(dup)}`);
  const badKind: string[] = [];
  const badCitation: string[] = [];
  for (const node of nodes) {
    if (!(REVERSE_SPEC_NODE_KINDS as readonly unknown[]).includes(node.kind))
      badKind.push(String(node.id));
    if (node.path !== undefined) {
      const problem = source.checkCitation(
        { path: node.path, line: node.line ?? 1 },
        { allowEmptyFile: true }
      );
      if (problem) badCitation.push(`${String(node.id)} (${problem})`);
    }
  }
  if (badKind.length)
    problems.push(`nodes with kind outside module|entrypoint|boundary: ${capList(badKind)}`);
  if (badCitation.length)
    problems.push(`node locations that do not resolve: ${capList(badCitation)}`);
  const nodeIds = new Set(ids);
  problems.push(...deriveDenominatorProblems(graph, source, nodeIds, declared.uncoveredExtensions));
  const dangling = records(graph.edges)
    .filter((edge) => !nodeIds.has(String(edge.from)) || !nodeIds.has(String(edge.to)))
    .map((edge) => `${String(edge.from)}->${String(edge.to)}`);
  if (dangling.length) problems.push(`edges referencing unknown nodes: ${capList(dangling)}`);
  // The reconciliation must describe the nodes actually listed: counts and element differences are
  // recomputed from each node's routes. Module omissions are caught against the source tree above;
  // entrypoint/boundary markers are trusted to the extractor (re-running it is the stronger check).
  const reconciliation = records(graph.reconciliation);
  for (const row of reconciliation) {
    if (!(REVERSE_SPEC_NODE_KINDS as readonly unknown[]).includes(row.node_kind))
      problems.push(`reconciliation row for unknown node kind ${String(row.node_kind)}`);
  }
  const unrouted: string[] = [];
  for (const kind of REVERSE_SPEC_NODE_KINDS) {
    const rows = reconciliation.filter((row) => row.node_kind === kind);
    if (rows.length !== 1) {
      problems.push(`reconciliation needs exactly one ${kind} row (found ${rows.length})`);
      continue;
    }
    const row = rows[0];
    const routeA = isRecord(row.route_a) ? row.route_a : {};
    const routeB = isRecord(row.route_b) ? row.route_b : {};
    const keysA = new Set<string>();
    const keysB = new Set<string>();
    for (const node of nodes.filter((entry) => entry.kind === kind)) {
      const routes = stringList(node.routes);
      if (!routes.includes('a') && !routes.includes('b')) unrouted.push(String(node.id));
      if (routes.includes('a')) keysA.add(reconciliationKey(node));
      if (routes.includes('b')) keysB.add(reconciliationKey(node));
    }
    for (const [name, route, keys] of [
      ['route_a', routeA, keysA],
      ['route_b', routeB, keysB],
    ] as const) {
      if (!nonEmpty(route.definition))
        problems.push(`reconciliation ${kind}: ${name} needs a definition`);
      if (route.count !== keys.size)
        problems.push(
          `reconciliation ${kind}: ${name}.count ${String(route.count)} does not match the ${keys.size} ${kind} node(s) found by that route`
        );
    }
    const onlyA = new Set([...keysA].filter((key) => !keysB.has(key)));
    const onlyB = new Set([...keysB].filter((key) => !keysA.has(key)));
    if (!Array.isArray(row.only_in_a) || !Array.isArray(row.only_in_b)) {
      problems.push(
        `reconciliation ${kind}: only_in_a / only_in_b element lists required (equal counts do not prove equal sets)`
      );
      continue;
    }
    if (!sameSet(stringList(row.only_in_a), onlyA) || !sameSet(stringList(row.only_in_b), onlyB))
      problems.push(
        `reconciliation ${kind}: only_in_a/only_in_b do not match the nodes' routes (expected ${onlyA.size}/${onlyB.size} element(s))`
      );
    if (onlyA.size + onlyB.size > 0 && !nonEmpty(row.resolution))
      problems.push(
        `reconciliation ${kind}: ${onlyA.size + onlyB.size} element difference(s) without a resolution`
      );
  }
  if (unrouted.length) problems.push(`nodes without routes (a|b): ${capList(unrouted)}`);
  if (problems.length)
    throw new ReverseSpecEvidenceError(
      'code_graph',
      REVERSE_SPEC_EVIDENCE_FILES.code_graph,
      problems
    );
  return {
    nodeIds,
    fingerprint: String(fingerprint.value),
    fileCount: Number(fingerprint.file_count ?? 0),
  };
}

function validateAnalysisDocument(missionDir: string, graph: CodeGraph): { itemIds: Set<string> } {
  const ledger = readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.analysis);
  const problems: string[] = [];
  const items = records(ledger.items);
  if (items.length === 0) problems.push('items must be non-empty');
  const itemIds = items.map((item) => String(item.id ?? ''));
  const dup = duplicates(itemIds);
  if (dup.length) problems.push(`duplicate analysis ids: ${capList(dup)}`);
  const badIds = itemIds.filter((id) => !ANALYSIS_ID_PATTERN.test(id));
  if (badIds.length)
    problems.push(
      `analysis ids must match ANA-<ARCH|REQ|API|DATA|BEHAVIOR|NFR>-<n>: ${capList(badIds)}`
    );
  const covered = new Set<string>();
  const dangling: string[] = [];
  for (const item of items) {
    if (
      typeof item.id === 'string' &&
      ANALYSIS_ID_PATTERN.test(item.id) &&
      item.id.split('-')[1] !== item.category
    )
      problems.push(`${item.id}: id prefix does not match category ${String(item.category)}`);
    if (!(REVERSE_SPEC_ANALYSIS_CATEGORIES as readonly unknown[]).includes(item.category))
      problems.push(
        `${String(item.id)}: category must be one of ${REVERSE_SPEC_ANALYSIS_CATEGORIES.join('|')}`
      );
    for (const nodeId of stringList(item.node_ids)) {
      if (graph.nodeIds.has(nodeId)) covered.add(nodeId);
      else dangling.push(`${String(item.id)}→${nodeId}`);
    }
  }
  for (const disposition of records(ledger.dispositions)) {
    const nodeId = String(disposition.node_id ?? '');
    if (!graph.nodeIds.has(nodeId)) {
      dangling.push(`disposition→${nodeId}`);
      continue;
    }
    if (disposition.status !== 'out_of_scope' && disposition.status !== 'no_behavior') {
      problems.push(`disposition ${nodeId}: status must be out_of_scope|no_behavior`);
      continue;
    }
    // Shrinking the denominator is a held decision: it needs a recorded reason and decision file.
    const decision = disposition.decision_ref;
    if (!nonEmpty(disposition.reason) || !nonEmpty(decision)) {
      problems.push(
        `disposition ${nodeId}: reason and decision_ref (mission decision record) required`
      );
      continue;
    }
    if (!missionFileExists(missionDir, decision)) {
      problems.push(
        `disposition ${nodeId}: decision_ref ${decision} does not exist in the mission`
      );
      continue;
    }
    const recordProblem = checkDecisionRecord(missionDir, decision, nodeId, disposition.status);
    if (recordProblem) {
      problems.push(`disposition ${nodeId}: ${recordProblem}`);
      continue;
    }
    covered.add(nodeId);
  }
  if (dangling.length)
    problems.push(`references to nodes not in the code graph: ${capList(dangling)}`);
  const uncovered = [...graph.nodeIds].filter((id) => !covered.has(id));
  if (uncovered.length)
    problems.push(
      `${uncovered.length}/${graph.nodeIds.size} code-graph nodes neither analyzed nor dispositioned: ${capList(uncovered)}`
    );
  if (problems.length)
    throw new ReverseSpecEvidenceError('analysis', REVERSE_SPEC_EVIDENCE_FILES.analysis, problems);
  return { itemIds: new Set(itemIds) };
}

interface SpecLedger {
  authorActorId: string;
  claims: Map<string, string>;
  specCount: number;
}

function validateSpecDocument(
  missionDir: string,
  purpose: ReverseSpecPurpose,
  source: SourceView,
  analysisIds: Set<string>
): SpecLedger {
  const ledger = readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.specify);
  const problems: string[] = [];
  if (!nonEmpty(ledger.author_actor_id))
    problems.push('author_actor_id required (the independent verifier must differ)');
  const specs = records(ledger.specs);
  if (specs.length === 0) problems.push('specs must be non-empty');
  const specIds = specs.map((spec) => String(spec.spec_id ?? ''));
  const dupSpecs = duplicates(specIds);
  if (dupSpecs.length) problems.push(`duplicate spec ids: ${capList(dupSpecs)}`);
  const badSpecIds = specIds.filter((id) => !SPEC_ID_PATTERN.test(id));
  if (badSpecIds.length)
    problems.push(`spec ids must match SPEC-<CATEGORY>-<name>-NN: ${capList(badSpecIds)}`);
  const claims = new Map<string, string>();
  const claimIds: string[] = [];
  const referenced = new Set<string>();
  const uncited: string[] = [];
  const unresolved: string[] = [];
  const unclassified: string[] = [];
  const noPopulation: string[] = [];
  let essence = 0;
  for (const spec of specs) {
    const specId = String(spec.spec_id ?? '?');
    if (spec.layer === 'essence') essence += 1;
    else if (spec.layer !== 'implementation')
      problems.push(`${specId}: layer must be implementation|essence`);
    const specPath = spec.path;
    if (!nonEmpty(specPath) || !missionFileExists(missionDir, specPath))
      problems.push(`${specId}: spec file ${String(specPath)} not found in the mission`);
    for (const ref of stringList(spec.analysis_refs)) {
      if (analysisIds.has(ref)) referenced.add(ref);
      else problems.push(`${specId}: analysis_ref ${ref} is not in the analysis ledger`);
    }
    for (const claim of records(spec.claims)) {
      const claimId = String(claim.claim_id ?? '');
      claimIds.push(claimId);
      const confidence = claim.confidence;
      if (!(REVERSE_SPEC_CONFIDENCE as readonly unknown[]).includes(confidence)) {
        problems.push(`${claimId || specId}: confidence must be confirmed|inferred|unknown`);
        continue;
      }
      claims.set(claimId, confidence as string);
      const citations = records(claim.citations);
      if (confidence === 'confirmed' && citations.length === 0) uncited.push(claimId);
      for (const citation of citations) {
        const problem = source.checkCitation(citation);
        if (problem) unresolved.push(`${claimId}: ${problem}`);
      }
      if (
        confidence === 'unknown' &&
        !(REVERSE_SPEC_UNKNOWN_CLASSES as readonly unknown[]).includes(claim.unknown_class)
      )
        unclassified.push(claimId);
      if (claim.universal === true) {
        const population = isRecord(claim.population) ? claim.population : {};
        if (!nonEmpty(population.method) || !Number.isInteger(population.count))
          noPopulation.push(claimId);
      }
    }
  }
  const dupClaims = duplicates(claimIds);
  if (dupClaims.length) problems.push(`duplicate claim ids: ${capList(dupClaims)}`);
  const unnamed = specs
    .filter((spec) => records(spec.claims).some((claim) => !nonEmpty(claim.claim_id)))
    .map((spec) => String(spec.spec_id ?? '?'));
  if (unnamed.length) problems.push(`claims without claim_id in: ${capList(unnamed)}`);
  if (uncited.length)
    problems.push(`confirmed claims without a path:line citation: ${capList(uncited)}`);
  if (unresolved.length)
    problems.push(`citations that do not resolve in the source: ${capList(unresolved)}`);
  if (unclassified.length)
    problems.push(
      `unknown claims need unknown_class ${REVERSE_SPEC_UNKNOWN_CLASSES.join('|')}: ${capList(unclassified)}`
    );
  if (noPopulation.length)
    problems.push(
      `universal claims ("all/only/none") need population {method, count}: ${capList(noPopulation)}`
    );
  const unreferenced = [...analysisIds].filter((id) => !referenced.has(id));
  if (unreferenced.length)
    problems.push(`analysis items not carried into any spec: ${capList(unreferenced)}`);
  if (purpose !== 'maintenance' && essence === 0)
    problems.push(
      `purpose ${purpose} requires at least one technology-independent (essence layer) spec`
    );
  if (problems.length)
    throw new ReverseSpecEvidenceError('specify', REVERSE_SPEC_EVIDENCE_FILES.specify, problems);
  return { authorActorId: String(ledger.author_actor_id), claims, specCount: specs.length };
}

/**
 * Binds the ledger's self-declared author/verifier to the actors that recorded the specify and
 * independent-verify tasks in the mission execution ledger (record-evidence --actor-id).
 */
function identityProblems(missionDir: string, authorActorId: string, verifier: unknown): string[] {
  const problems: string[] = [];
  const authors = ledgerTaskActors(missionDir, REVERSE_SPEC_AUTHOR_TASK_SUFFIX);
  const verifiers = ledgerTaskActors(missionDir, REVERSE_SPEC_VERIFIER_TASK_SUFFIX);
  const next =
    'record the task with mission_controller record-evidence <MISSION> <TASK> … --actor-id <who did it>';
  if (authors.size === 0)
    problems.push(
      `no actor recorded for the *-${REVERSE_SPEC_AUTHOR_TASK_SUFFIX} task in execution-ledger.jsonl — ${next}`
    );
  else if (!authors.has(authorActorId.trim()))
    problems.push(
      `author_actor_id ${authorActorId} is not the actor that recorded the specify task (${[...authors].join(', ')})`
    );
  if (verifiers.size === 0)
    problems.push(
      `no actor recorded for the *-${REVERSE_SPEC_VERIFIER_TASK_SUFFIX} task in execution-ledger.jsonl — ${next}`
    );
  else if (nonEmpty(verifier) && !verifiers.has(verifier.trim()))
    problems.push(
      `verifier_actor_id ${verifier} is not the actor that recorded the independent-verify task (${[...verifiers].join(', ')})`
    );
  const both = [...verifiers].filter((actor) => authors.has(actor));
  if (both.length)
    problems.push(
      `actor(s) ${both.join(', ')} recorded both the specify and the independent-verify task — verification must be independent`
    );
  return problems;
}

/** Ids of the confirmed claims an audit with `random` sampling must verify, and the seed used. */
export function computeReverseSpecAuditSample(
  missionDir: string,
  requestedSize = 0
): {
  seed: string;
  population: number;
  sample: string[];
} {
  const ledger = readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.specify);
  const confirmed = records(ledger.specs)
    .flatMap((spec) => records(spec.claims))
    .filter((claim) => claim.confidence === 'confirmed' && nonEmpty(claim.claim_id))
    .map((claim) => String(claim.claim_id));
  const seed = auditSamplingSeed(missionDir);
  const size = Math.min(confirmed.length, Math.max(REVERSE_SPEC_MIN_SAMPLE, requestedSize));
  return {
    seed,
    population: confirmed.length,
    sample: selectReverseSpecAuditSample(confirmed, seed, size),
  };
}

function validateAuditDocument(
  missionDir: string,
  purpose: ReverseSpecPurpose,
  source: SourceView,
  graph: CodeGraph,
  specs: SpecLedger
): Record<string, number | string> {
  const ledger = readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.audit);
  const problems: string[] = [];
  if (!nonEmpty(ledger.verifier_actor_id)) problems.push('verifier_actor_id required');
  else if (ledger.verifier_actor_id.trim() === specs.authorActorId.trim())
    problems.push('verifier_actor_id equals the spec author — verification must be independent');
  problems.push(...identityProblems(missionDir, specs.authorActorId, ledger.verifier_actor_id));
  const latest = new Map<string, string>();
  const unknownClaims: string[] = [];
  for (const entry of records(ledger.entries)) {
    const claimId = String(entry.claim_id ?? '');
    if (!specs.claims.has(claimId)) {
      unknownClaims.push(claimId);
      continue;
    }
    if (!(REVERSE_SPEC_VERDICTS as readonly unknown[]).includes(entry.verdict)) {
      problems.push(`${claimId}: verdict must be ${REVERSE_SPEC_VERDICTS.join('|')}`);
      continue;
    }
    if (entry.verdict === 'partial' && !nonEmpty(entry.note))
      problems.push(`${claimId}: partial verdict needs a note naming what is missing`);
    latest.set(claimId, entry.verdict as string);
  }
  if (unknownClaims.length)
    problems.push(`entries for claims not in the spec ledger: ${capList(unknownClaims)}`);
  const evidenced = [...specs.claims]
    .filter(([, confidence]) => confidence !== 'unknown')
    .map(([id]) => id);
  const confirmed = [...specs.claims]
    .filter(([, confidence]) => confidence === 'confirmed')
    .map(([id]) => id);
  const sampling = isRecord(ledger.sampling) ? ledger.sampling : {};
  if (purpose === 'rebuild') {
    const unverified = evidenced.filter((id) => !latest.has(id));
    if (sampling.method !== 'full') problems.push('purpose rebuild requires sampling.method full');
    if (unverified.length)
      problems.push(
        `purpose rebuild verifies every confirmed/inferred claim; unverified: ${capList(unverified)}`
      );
  } else {
    if (sampling.method !== 'full' && sampling.method !== 'random')
      problems.push('sampling.method must be full|random');
    if (sampling.method === 'full') {
      const unverified = confirmed.filter((id) => !latest.has(id));
      if (unverified.length)
        problems.push(
          `sampling.method full verifies every confirmed claim; unverified: ${capList(unverified)} — use random for a derived sample`
        );
    }
    if (sampling.population !== confirmed.length)
      problems.push(
        `sampling.population must equal the confirmed-claim count (${confirmed.length})`
      );
    const required = Math.min(confirmed.length, REVERSE_SPEC_MIN_SAMPLE);
    const verifiedConfirmed = confirmed.filter((id) => latest.has(id)).length;
    if (verifiedConfirmed < required)
      problems.push(
        `only ${verifiedConfirmed} confirmed claims verified; at least ${required} required`
      );
    if (sampling.method === 'random') {
      // The sample is derived, not chosen: a verifier cannot pick the easy claims.
      const seed = auditSamplingSeed(missionDir);
      if (sampling.seed !== seed)
        problems.push(
          `sampling.seed must be ${seed} (sha256 of the canonical spec-ledger.json) — print the sample with check_reverse_spec_evidence --print-sample`
        );
      const size = Math.min(
        confirmed.length,
        Math.max(
          required,
          Number.isInteger(sampling.sample_size) ? Number(sampling.sample_size) : 0
        )
      );
      const unsampled = selectReverseSpecAuditSample(confirmed, seed, size).filter(
        (id) => !latest.has(id)
      );
      if (unsampled.length)
        problems.push(
          `sampled claims not verified (sample derived from the spec ledger seed): ${capList(unsampled)}`
        );
    }
  }
  const open = [...latest].filter(
    ([, verdict]) => verdict === 'unsupported' || verdict === 'fabricated'
  );
  if (open.length)
    problems.push(
      `${open.length} claim(s) still unsupported/fabricated — correct or downgrade them, then re-verify: ${capList(open.map(([id]) => id))}`
    );
  const now = computeSourceFingerprint(source.root.absolute, { files: [...source.files()] });
  if (now.value !== graph.fingerprint)
    problems.push(
      `source changed since the code graph was frozen (fingerprint ${graph.fingerprint.slice(0, 12)}… → ${now.value.slice(0, 12)}…, files ${graph.fileCount} → ${now.file_count}) — the analysis target must stay read-only`
    );
  if (problems.length)
    throw new ReverseSpecEvidenceError('audit', REVERSE_SPEC_EVIDENCE_FILES.audit, problems);
  return {
    purpose,
    claims: specs.claims.size,
    verified: latest.size,
    nodes: graph.nodeIds.size,
  };
}

/** Validate one reverse_spec stage against a mission directory; throws on failure. */
export function validateReverseSpecEvidenceAt(
  missionDir: string,
  stage: ReverseSpecEvidenceStage
): ReverseSpecEvidenceResult {
  if (!(REVERSE_SPEC_EVIDENCE_STAGES as readonly string[]).includes(stage))
    fail(
      `unknown stage ${stage} — why: not a reverse_spec gate stage | next: use one of ${REVERSE_SPEC_EVIDENCE_STAGES.join('|')}`
    );
  const evidencePath = path.join(missionDir, REVERSE_SPEC_EVIDENCE_FILES[stage]);
  if (stage === 'scope')
    return { stage, path: evidencePath, ok: true, summary: validateScope(missionDir) };
  // Later stages build on the earlier ledgers: each gate re-checks what it depends on.
  // A graph extracted with a raised max_files must be re-listed with the same ceiling.
  const recordedFiles = graphFileCount(missionDir);
  const { scope, purpose, source } = loadScope(
    missionDir,
    Math.max(DEFAULT_SOURCE_TREE_MAX_FILES, recordedFiles ?? 0)
  );
  const declared = {
    exclusions: records(scope.exclusions)
      .filter((exclusion) => nonEmpty(exclusion.reason))
      .map((exclusion) => path.posix.normalize(String(exclusion.path ?? '')).replace(/\/$/u, '')),
    uncoveredExtensions: records(scope.uncovered_extensions)
      .filter((entry) => nonEmpty(entry.reason))
      .map((entry) => String(entry.extension ?? '').toLowerCase()),
  };
  const graph = validateCodeGraphDocument(missionDir, source, declared);
  if (stage === 'code_graph')
    return {
      stage,
      path: evidencePath,
      ok: true,
      summary: { nodes: graph.nodeIds.size, files: graph.fileCount },
    };
  const analysis = validateAnalysisDocument(missionDir, graph);
  if (stage === 'analysis')
    return {
      stage,
      path: evidencePath,
      ok: true,
      summary: { nodes: graph.nodeIds.size, analysis_items: analysis.itemIds.size },
    };
  const specs = validateSpecDocument(missionDir, purpose, source, analysis.itemIds);
  if (stage === 'specify')
    return {
      stage,
      path: evidencePath,
      ok: true,
      summary: { specs: specs.specCount, claims: specs.claims.size },
    };
  return {
    stage,
    path: evidencePath,
    ok: true,
    summary: validateAuditDocument(missionDir, purpose, source, graph, specs),
  };
}

/** Purpose recorded in a mission's reverse_spec scope (used by legacy_migration intake). */
export function readReverseSpecPurpose(missionDir: string): ReverseSpecPurpose {
  return loadScope(missionDir).purpose;
}

/** Spec ids of a mission's reverse_spec ledger, by layer. */
export function readReverseSpecSpecIds(missionDir: string): { spec_id: string; layer: string }[] {
  return records(readJsonEvidence(missionDir, REVERSE_SPEC_EVIDENCE_FILES.specify).specs).map(
    (spec) => ({
      spec_id: String(spec.spec_id ?? ''),
      layer: String(spec.layer ?? ''),
    })
  );
}

export function resolveReverseSpecMissionDir(missionId: string): string {
  const dir = findMissionPath(missionId);
  if (!dir)
    fail(
      `mission directory not found for ${missionId} — why: the mission locator returned nothing visible to this process | next: check the id with pnpm mission list (tier/tenant scope)`
    );
  return dir;
}

/** Validate one reverse_spec evidence stage for a mission; throws on failure. */
export function assertReverseSpecEvidence(
  missionId: string,
  stage: ReverseSpecEvidenceStage
): ReverseSpecEvidenceResult {
  return validateReverseSpecEvidenceAt(resolveReverseSpecMissionDir(missionId), stage);
}
