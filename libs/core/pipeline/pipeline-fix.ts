/**
 * `pnpm pipeline fix <file>`: the mechanical rewrites that make a pipeline's
 * steps pre-approvable (pipeline-run-manifest-model.md §5).
 *
 * `pnpm pipeline check` tells the owner why steps still ask per step. Three of
 * those reasons have a rewrite that does not need judgment:
 *
 * 1. a templated page script (`templated_script`) → `(a) => …` + `args`
 *    (run-manifest-args-suggest.ts; it declines credentials and unsafe shapes);
 * 2. a native step that writes a file outside the run's partition
 *    (`write_path_unconfined`) → the compiler's `suggested_path`;
 * 3. `options.user_data_dir` outside the profile partition → the same folder
 *    name under `active/shared/runtime/browser/profiles/<tier>/<tenant>/`.
 *
 * This module plans those rewrites as targeted text edits (json-source-edit.ts
 * — the file is never re-serialized), recompiles the fixed text and compares
 * coverage. It is pure: it reads no file and writes nothing. A plan carries a
 * `refusal` when writing it would be wrong (coverage worse, a change outside
 * the targeted values, an ADF that no longer validates).
 */
import * as path from 'node:path';
import { isRecord } from '../foundation/primitives.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import * as pathResolver from '../path-resolver.js';
import {
  applyJsonTextEdits,
  formatJsonPath,
  inlineJsonObject,
  insertMemberEdit,
  jsonPathKey,
  replaceValueEdit,
  scanJsonSource,
  unifiedDiffForEdits,
  type JsonPath,
  type JsonSourceMap,
  type JsonTextEdit,
} from './json-source-edit.js';
import {
  browserProfilePartition,
  classifyPipelineBrowserOptions,
  pipelineUsesBrowser,
} from './pipeline-browser-options.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import { ARGS_SUGGESTION_CAVEAT, suggestEvaluateStepArgs } from './run-manifest-args-suggest.js';
import { secretExportVariables, type RunManifest } from './run-manifest.js';
import { BROWSER_NATIVE_FORMAT, isNativeBrowserPipelineDocument } from './run-manifest-native.js';
import {
  compilePipelineFileRunManifest,
  type RunManifestFileScope,
} from './run-manifest-session.js';

export type PipelineFixKind = 'evaluate_args' | 'write_path' | 'user_data_dir';

export interface PipelineFixItem {
  kind: PipelineFixKind;
  /** `step 4` or `options.user_data_dir`. */
  location: string;
  entry_id?: string;
  operation_id?: string;
  before: string;
  after: string;
  /** Recompiled status of the step after the fix (effects only). */
  result?: string;
  note?: string;
}

export interface PipelineFixManualItem {
  kind: PipelineFixKind;
  location: string;
  reason: string;
}

export interface PipelineFixCoverage {
  external: number;
  pre_approvable: number;
  complete: boolean;
  per_step: Array<{ entry_id: string; operation_id: string; reason: string }>;
  /** The persistent profile a bound run uses. */
  browser_profile?: string;
}

/** A profile directory the owner may move along with the rewrite (`--move-profile`). */
export interface PipelineFixProfileMove {
  /** Repo-relative (or absolute, when outside the repository) authored directory. */
  from: string;
  to: string;
  /** Why the directory cannot be moved by the command (copy it by hand instead). */
  refused?: string;
}

export interface PipelineFixPlan {
  input_path: string;
  format: 'adf' | 'browser_native';
  fixes: PipelineFixItem[];
  manual: PipelineFixManualItem[];
  before: PipelineFixCoverage;
  after: PipelineFixCoverage;
  edits: JsonTextEdit[];
  fixed_text: string;
  diff: string[];
  profile_move?: PipelineFixProfileMove;
  /** Set when the fixed file must not be written. */
  refusal?: string;
  caveat?: string;
}

function fixError(code: string, what: string, why: string, next: string): Error {
  return new Error(`[${code}] ${what} — ${why} | next: ${next}`);
}

/** JSON path of the step at a Run Manifest entry id (mirrors locateStepByEntryId). */
function entryJsonPath(steps: unknown, entryId: string): Array<string | number> | undefined {
  const out: Array<string | number> = ['steps'];
  let current: unknown = steps;
  for (const segment of entryId.split('.')) {
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
      out.push(Number(segment));
    } else if (isRecord(current) && typeof current.op === 'string') {
      if (segment === 'on_error') {
        current = current.on_error;
        out.push('on_error');
      } else {
        current = isRecord(current.params) ? current.params[segment] : undefined;
        out.push('params', segment);
      }
    } else if (isRecord(current)) {
      current = current[segment];
      out.push(segment);
    } else return undefined;
  }
  return isRecord(current) ? out : undefined;
}

function valueAt(document: unknown, at: JsonPath): unknown {
  let current: unknown = document;
  for (const segment of at) {
    if (Array.isArray(current) && typeof segment === 'number') current = current[segment];
    else if (isRecord(current) && typeof segment === 'string') current = current[segment];
    else return undefined;
  }
  return current;
}

/** Every string leaf with its path. */
function stringLeaves(value: unknown, at: Array<string | number> = []): Array<[string, string]> {
  if (typeof value === 'string') return [[jsonPathKey(at), value]];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => stringLeaves(entry, [...at, index]));
  if (isRecord(value))
    return Object.entries(value).flatMap(([key, entry]) => stringLeaves(entry, [...at, key]));
  return [];
}

/** Paths where two parsed documents differ (leaf level; a changed container shape is one path). */
function structuralDiff(a: unknown, b: unknown, at: Array<string | number> = []): JsonPath[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [at];
    return a.flatMap((entry, index) => structuralDiff(entry, b[index], [...at, index]));
  }
  if (isRecord(a) && isRecord(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) =>
      key in a && key in b ? structuralDiff(a[key], b[key], [...at, key]) : [[...at, key]]
    );
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

function within(candidate: JsonPath, prefix: JsonPath): boolean {
  return prefix.length <= candidate.length && prefix.every((seg, i) => candidate[i] === seg);
}

interface CompiledDocument {
  format: PipelineFixPlan['format'];
  parsed: Record<string, unknown>;
  rawSteps: unknown[];
  manifest: RunManifest;
}

function compileDocument(
  sourceText: string,
  scope: RunManifestFileScope,
  label: string
): CompiledDocument {
  const parsed = parseSafeJsonInput(sourceText, label);
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  if (isNativeBrowserPipelineDocument(parsed)) {
    return {
      format: BROWSER_NATIVE_FORMAT,
      parsed,
      rawSteps: parsed.steps as unknown[],
      manifest: compilePipelineFileRunManifest({
        scope,
        sourceText,
        pipeline: parsed,
        format: BROWSER_NATIVE_FORMAT,
      }),
    };
  }
  const pipeline = validatePipelineAdf(parsed);
  return {
    format: 'adf',
    parsed,
    rawSteps: Array.isArray(parsed.steps) ? parsed.steps : [],
    manifest: compilePipelineFileRunManifest({ scope, sourceText, pipeline }),
  };
}

function coverageOf(manifest: RunManifest): PipelineFixCoverage {
  const effects = manifest.requirements.effects;
  return {
    external: effects.length,
    pre_approvable: effects.filter((entry) => entry.bindable).length,
    complete: manifest.complete,
    per_step: effects
      .filter((entry) => !entry.bindable)
      .map((entry) => ({
        entry_id: entry.entry_id,
        operation_id: entry.operation_id,
        reason: entry.unbindable_reason ?? 'unbindable',
      })),
    ...(manifest.requirements.browser_profile
      ? { browser_profile: manifest.requirements.browser_profile.user_data_dir }
      : {}),
  };
}

const PROFILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u;
/** The scratch floor and the browser runtime directory, repo-relative with a trailing slash. */
function movableProfileRoots(): [string, string] {
  const relative = (sub: string) => `${pathResolver.toRepoRelative(pathResolver.shared(sub))}/`;
  return [relative('tmp'), relative('runtime/browser')];
}
const TIER_SEGMENTS = new Set(['personal', 'confidential', 'public']);
/** Unpartitioned folders other runs use (the default export dir, floors); never moved wholesale. */
const SHARED_LEGACY_SEGMENTS = new Set(['profiles', 'browser', 'system', 'shared']);

/**
 * Where `--move-profile` may take the authored profile from (pure path rules).
 * An allowlist: a folder inside this file's own scratch partition, or a named
 * legacy folder under the unpartitioned tmp / runtime-browser floors. Segments
 * are compared case-folded so `Profiles/` or `CONFIDENTIAL/` (one directory on
 * a case-insensitive disk) cannot slip past.
 */
function profileMoveOf(
  authored: string,
  target: string,
  scope: RunManifestFileScope
): PipelineFixProfileMove {
  const root = pathResolver.rootDir();
  const absolute = path.resolve(root, authored);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const outside = !relative || relative.startsWith('..') || path.isAbsolute(relative);
  const from = outside ? absolute : relative;
  const refuse = (why: string): PipelineFixProfileMove => ({ from, to: target, refused: why });
  if (outside) return refuse('it is outside the repository');
  const segments = relative.split('/');
  const restAfter = (prefix: string): string[] | undefined => {
    const head = prefix.split('/').filter(Boolean);
    return head.every((segment, index) => segments[index]?.toLowerCase() === segment)
      ? segments.slice(head.length)
      : undefined;
  };
  const roots = movableProfileRoots();
  const tmpRest = restAfter(roots[0]);
  const rest = tmpRest ?? restAfter(roots[1]);
  if (!rest || rest.length === 0)
    return refuse(`only folders under ${roots.join(' or ')} are moved`);
  if (!rest.every((segment) => PROFILE_SEGMENT.test(segment) && !/^\.+$/u.test(segment)))
    return refuse('a folder on its path is not a plain name');
  const head = rest[0].toLowerCase();
  if (head === 'profiles') return refuse('it belongs to another run partition');
  if (tmpRest && TIER_SEGMENTS.has(head)) {
    // Partitioned scratch: only this file's own partition, never the partition root.
    if (rest[0] !== scope.tier || rest[1] !== (scope.tenant_slug ?? 'shared'))
      return refuse(`it sits in the ${rest[0]}/${rest[1] ?? ''} partition, not this file's`);
    if (rest.length < 3) return refuse('it is the partition root, not a profile folder');
    return { from: relative, to: target };
  }
  if (TIER_SEGMENTS.has(head) || SHARED_LEGACY_SEGMENTS.has(head))
    return refuse(`${segments.slice(0, segments.length - rest.length + 1).join('/')} is shared`);
  return { from: relative, to: target };
}

interface PlannedEdit {
  edits: JsonTextEdit[];
  targets: JsonPath[];
}

function planEvaluateFixes(
  compiled: CompiledDocument,
  map: JsonSourceMap,
  fixes: PipelineFixItem[],
  manual: PipelineFixManualItem[]
): PlannedEdit {
  const out: PlannedEdit = { edits: [], targets: [] };
  // Credentials (secret:get exports, {{env.X}}) are never moved into args.
  const secretVariables = secretExportVariables(compiled.rawSteps);
  for (const entry of compiled.manifest.requirements.effects) {
    if (entry.unbindable_reason !== 'templated_script') continue;
    const location = `step ${entry.entry_id}`;
    const stepPath = entryJsonPath(compiled.rawSteps, entry.entry_id);
    const step = stepPath ? valueAt(compiled.parsed, stepPath) : undefined;
    const suggestion = step
      ? suggestEvaluateStepArgs(step, { secretVariables })
      : { ok: false as const, reason: 'the step could not be located' };
    const authoredParams = stepPath ? valueAt(compiled.parsed, [...stepPath, 'params']) : undefined;
    const existingArgs = isRecord(authoredParams) && 'args' in authoredParams;
    if ('reason' in suggestion || !stepPath || existingArgs) {
      manual.push({
        kind: 'evaluate_args',
        location,
        reason: !stepPath
          ? 'the step could not be located'
          : existingArgs
            ? 'the step already has args — merge the templated values into them by hand'
            : 'reason' in suggestion
              ? suggestion.reason
              : 'the step could not be located',
      });
      continue;
    }
    const params = [...stepPath, 'params'];
    const scriptPath = [...params, 'script'];
    out.edits.push(
      replaceValueEdit(map, scriptPath, JSON.stringify(suggestion.script)),
      insertMemberEdit(map, params, 'args', inlineJsonObject(suggestion.args), 'script')
    );
    out.targets.push(scriptPath, [...params, 'args']);
    fixes.push({
      kind: 'evaluate_args',
      location,
      entry_id: entry.entry_id,
      operation_id: entry.operation_id,
      before: 'templated page script',
      after: `page function + args { ${Object.keys(suggestion.args).join(', ')} }`,
      ...(suggestion.note ? { note: suggestion.note } : {}),
    });
  }
  return out;
}

function planWritePathFixes(
  compiled: CompiledDocument,
  map: JsonSourceMap,
  fixes: PipelineFixItem[],
  manual: PipelineFixManualItem[]
): PlannedEdit {
  const out: PlannedEdit = { edits: [], targets: [] };
  const writes = compiled.manifest.requirements.effects.filter(
    (entry) => entry.unbindable_reason === 'write_path_unconfined' && entry.write
  );
  // Two different files folded onto one confined name would overwrite each other.
  const sources = new Map<string, Set<string>>();
  for (const entry of writes) {
    const set = sources.get(entry.write!.suggested_path) ?? new Set<string>();
    set.add(entry.write!.path);
    sources.set(entry.write!.suggested_path, set);
  }
  const leaves = stringLeaves(compiled.parsed);
  for (const entry of writes) {
    const write = entry.write!;
    const location = `step ${entry.entry_id}`;
    const stepPath = entryJsonPath(compiled.rawSteps, entry.entry_id);
    const params = stepPath ? valueAt(compiled.parsed, [...stepPath, 'params']) : undefined;
    const reason = !stepPath
      ? 'the step could not be located'
      : !isRecord(params)
        ? 'the step has no params object'
        : (sources.get(write.suggested_path)?.size ?? 0) > 1
          ? `another step's file would land on the same ${write.suggested_path}`
          : undefined;
    const pathKey = stepPath ? jsonPathKey([...stepPath, 'params', 'path']) : '';
    const reference = reason
      ? undefined
      : leaves.find(([key, value]) => key !== pathKey && value.includes(write.path));
    if (reason || reference) {
      manual.push({
        kind: 'write_path',
        location,
        reason:
          reason ??
          `${write.path} is also referenced at ${formatJsonPath(JSON.parse(reference![0]) as JsonPath)} — move both by hand`,
      });
      continue;
    }
    const target = [...stepPath!, 'params', 'path'];
    const authored = isRecord(params) && typeof params.path === 'string' && params.path;
    out.edits.push(
      authored
        ? replaceValueEdit(map, target, JSON.stringify(write.suggested_path))
        : insertMemberEdit(
            map,
            [...stepPath!, 'params'],
            'path',
            JSON.stringify(write.suggested_path)
          )
    );
    out.targets.push(target);
    fixes.push({
      kind: 'write_path',
      location,
      entry_id: entry.entry_id,
      operation_id: entry.operation_id,
      before: authored ? write.path : `${write.path} (default)`,
      after: write.suggested_path,
    });
  }
  return out;
}

function planProfileFix(
  compiled: CompiledDocument,
  map: JsonSourceMap,
  scope: RunManifestFileScope,
  fixes: PipelineFixItem[],
  manual: PipelineFixManualItem[]
): PlannedEdit & { move?: PipelineFixProfileMove } {
  const out: PlannedEdit = { edits: [], targets: [] };
  const options = compiled.parsed.options;
  // Every native step is a browser step; an ADF needs one browser:* step.
  const usesBrowser =
    compiled.format === BROWSER_NATIVE_FORMAT || pipelineUsesBrowser(compiled.parsed.steps);
  if (!usesBrowser || !isRecord(options) || options.user_data_dir === undefined) return out;
  const browserScope = {
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
  };
  const dropped = classifyPipelineBrowserOptions(options, browserScope).dropped.some(
    (entry) => entry.option === 'user_data_dir'
  );
  if (!dropped) return out;
  const location = 'options.user_data_dir';
  const authored = options.user_data_dir;
  const name =
    typeof authored === 'string'
      ? path.posix.basename(authored.trim().replaceAll('\\', '/').replace(/\/+$/u, ''))
      : '';
  const reason =
    typeof authored !== 'string'
      ? 'it is not a string path'
      : authored.includes('{{')
        ? 'it is templated'
        : !PROFILE_SEGMENT.test(name) || /^\.+$/u.test(name)
          ? `its folder name ${JSON.stringify(name)} is not a plain name`
          : undefined;
  if (reason) {
    manual.push({ kind: 'user_data_dir', location, reason });
    return out;
  }
  const target = `${browserProfilePartition(browserScope)}/${name}`;
  out.edits.push(replaceValueEdit(map, ['options', 'user_data_dir'], JSON.stringify(target)));
  out.targets.push(['options', 'user_data_dir']);
  const move = profileMoveOf(authored as string, target, scope);
  fixes.push({
    kind: 'user_data_dir',
    location,
    before: `${authored as string} (dropped: outside the profile partition)`,
    after: target,
    note: move.refused
      ? `the existing profile is not moved (${move.refused}) — the first run logs in again unless you copy it to ${target}`
      : `the existing profile stays at ${move.from} unless you add --move-profile; another pipeline whose profile folder is also named ${name} would share this login`,
  });
  return { ...out, move };
}

/**
 * Plan the fixes of one pipeline file's exact text. Throws a diagnostic when
 * the text cannot be fixed at all (not a JSON pipeline, duplicate keys, an
 * ADF that does not validate).
 */
export function planPipelineFix(input: {
  sourceText: string;
  scope: RunManifestFileScope;
}): PipelineFixPlan {
  const file = input.scope.input_path;
  let map: JsonSourceMap;
  let before: CompiledDocument;
  try {
    map = scanJsonSource(input.sourceText);
    before = compileDocument(input.sourceText, input.scope, 'pipeline file');
  } catch (error) {
    throw fixError(
      'PIPELINE_FIX_UNREADABLE',
      `${file} cannot be fixed`,
      error instanceof Error ? error.message : String(error),
      `pnpm pipeline check ${file}`
    );
  }
  if (map.duplicateKeys.length)
    throw fixError(
      'PIPELINE_FIX_DUPLICATE_KEYS',
      `${file} repeats ${map.duplicateKeys.slice(0, 3).join(', ')}`,
      'JSON readers disagree on which duplicate wins, so no edit can be placed safely',
      'remove the duplicate keys by hand, then run pnpm pipeline fix again'
    );
  const fixes: PipelineFixItem[] = [];
  const manual: PipelineFixManualItem[] = [];
  const evaluate = planEvaluateFixes(before, map, fixes, manual);
  const writes = planWritePathFixes(before, map, fixes, manual);
  const profile = planProfileFix(before, map, input.scope, fixes, manual);
  const edits = [...evaluate.edits, ...writes.edits, ...profile.edits];
  const targets = [...evaluate.targets, ...writes.targets, ...profile.targets];
  const fixedText = applyJsonTextEdits(input.sourceText, edits);
  const beforeCoverage = coverageOf(before.manifest);
  const plan: PipelineFixPlan = {
    input_path: file,
    format: before.format === BROWSER_NATIVE_FORMAT ? 'browser_native' : 'adf',
    fixes,
    manual,
    before: beforeCoverage,
    after: beforeCoverage,
    edits,
    fixed_text: fixedText,
    diff: edits.length
      ? unifiedDiffForEdits(input.sourceText, edits, { from: `a/${file}`, to: `b/${file}` })
      : [],
    ...(profile.move ? { profile_move: profile.move } : {}),
    ...(fixes.some((fix) => fix.kind === 'evaluate_args')
      ? { caveat: ARGS_SUGGESTION_CAVEAT }
      : {}),
  };
  if (edits.length === 0) return plan;

  let after: CompiledDocument;
  try {
    after = compileDocument(fixedText, input.scope, 'fixed pipeline');
  } catch (error) {
    return {
      ...plan,
      refusal: `the fixed file no longer compiles — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  plan.after = coverageOf(after.manifest);
  const status = new Map(
    after.manifest.requirements.effects.map((entry) => [
      `${entry.entry_id}\u0000${entry.operation_id}`,
      entry.bindable ? 'pre-approvable' : `still per-step (${entry.unbindable_reason})`,
    ])
  );
  for (const fix of fixes)
    if (fix.entry_id)
      fix.result =
        status.get(`${fix.entry_id}\u0000${fix.operation_id}`) ??
        (fix.kind === 'write_path' ? 'pre-approvable' : 'not an external step any more');

  // Only the targeted values may differ, and the format must not change.
  const stray = structuralDiff(before.parsed, after.parsed).filter(
    (changed) => !targets.some((target) => within(changed, target))
  );
  if (stray.length)
    return {
      ...plan,
      refusal: `the edit changed ${stray.map(formatJsonPath).join(', ')}, which no fix targets`,
    };
  if (after.format !== before.format)
    return { ...plan, refusal: 'the edit changed how the file is read (ADF vs native)' };
  const worse =
    plan.after.pre_approvable < plan.before.pre_approvable ||
    plan.after.per_step.length > plan.before.per_step.length ||
    (plan.before.complete && !plan.after.complete);
  if (worse)
    return {
      ...plan,
      refusal: `coverage would get worse (${plan.before.pre_approvable}/${plan.before.external} → ${plan.after.pre_approvable}/${plan.after.external})`,
    };
  return plan;
}

/** `K of M` for the summary line. */
export function formatFixCoverage(coverage: PipelineFixCoverage): string {
  return `${coverage.pre_approvable} of ${coverage.external} external step(s) pre-approvable${
    coverage.complete ? '' : ' (manifest incomplete)'
  }`;
}

/** Human report lines of a plan (the CLI adds the diff and the next commands). */
export function formatPipelineFixPlan(plan: PipelineFixPlan): string[] {
  const lines = [
    `[pipeline-fix] ${plan.input_path} (${plan.format === 'browser_native' ? 'native browser pipeline' : 'pipeline ADF'})`,
    ` coverage  ${formatFixCoverage(plan.before)} → after fix: ${formatFixCoverage(plan.after)}`,
  ];
  if (plan.before.browser_profile !== plan.after.browser_profile)
    lines.push(
      ` profile   ${plan.before.browser_profile ?? '(none)'} → ${plan.after.browser_profile ?? '(none)'}`
    );
  for (const fix of plan.fixes) {
    const result = fix.result ? ` → ${fix.result}` : '';
    lines.push(
      ` fix       ${fix.location}${fix.operation_id ? ` ${fix.operation_id}` : ''}: ${fix.before} → ${fix.after}${result}`
    );
    if (fix.note) lines.push(`           ${fix.note}`);
  }
  if (plan.caveat) lines.push(`           ${plan.caveat}`);
  for (const item of plan.manual) lines.push(` manual    ${item.location}: ${item.reason}`);
  const fixed = new Set(plan.fixes.map((fix) => `${fix.entry_id} ${fix.operation_id}`));
  const remaining = plan.after.per_step.filter(
    (entry) => !fixed.has(`${entry.entry_id} ${entry.operation_id}`)
  );
  if (remaining.length)
    lines.push(
      ` per-step  ${remaining.map((entry) => `${entry.entry_id} ${entry.operation_id} (${entry.reason})`).join(', ')}`
    );
  if (plan.refusal) lines.push(` refused   ${plan.refusal}`);
  return lines;
}
