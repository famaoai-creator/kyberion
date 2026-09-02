#!/usr/bin/env node
/**
 * Golden Output Check (Phase B-4)
 *
 * Runs each registered ADF pipeline against a stub-backed environment, then
 * compares its output to a recorded "golden" snapshot. Detects unintended
 * semantic regressions in pipeline output (vs. the contract-semver check
 * which catches structural breakage).
 *
 * Modes:
 *   pnpm check -- --scope pr --only golden  # check mode (CI)
 *   node dist/scripts/check_golden_output.js --rebaseline
 *                                            # update snapshots after intentional changes
 *
 * Registry: tests/golden/pipelines.json — list of pipelines to gate.
 * Snapshots: tests/golden/snapshots/{pipeline-id}.json
 *
 * The "golden" output is a normalized projection of the pipeline result that
 * elides volatile fields (timestamps, UUIDs, ephemeral paths). The remaining
 * shape is what we promise to maintain across releases for stable pipelines.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { nowIso, readJson } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface GoldenRegistryEntry {
  /** Stable pipeline identifier (matches `id` field in the ADF JSON). */
  id: string;
  /** Path to the ADF pipeline JSON, relative to project root. */
  pipeline: string;
  /** Optional human-readable note for why this pipeline is in the golden set. */
  note?: string;
  /** Optional input context to seed the run. */
  input?: Record<string, unknown>;
  /** Fields to elide from comparison (dot-paths into the result context). */
  ignore_paths?: string[];
}

interface GoldenSnapshot {
  generated_at: string;
  pipeline_id: string;
  pipeline_path: string;
  result_hash: string;
  /** Normalized projection of the result (the actual snapshot). */
  result: unknown;
}

const ROOT = pathResolver.rootDir();
const REGISTRY_PATH = path.join(ROOT, 'tests', 'golden', 'pipelines.json');
const SNAPSHOTS_DIR = path.join(ROOT, 'tests', 'golden', 'snapshots');

const DEFAULT_IGNORE_PATHS = [
  'timestamp',
  'session_id',
  'trace',
  'trace_summary',
  'trace_persisted_path',
  'persistedPath',
  'context.repo_root',
  'context.platform_name',
  'context.node_options',
  'context.run_utc_now',
  'context.__pipeline_options',
  'context.trust_resolved',
  'context.trace_persisted_path',
  'last_screenshot',
  'last_trace_path',
  'recorded_videos',
  '_persistedAt',
];

function loadRegistry(): GoldenRegistryEntry[] {
  if (!safeExistsSync(REGISTRY_PATH)) return [];
  return readJson<GoldenRegistryEntry[]>(REGISTRY_PATH);
}

function loadSnapshot(id: string): GoldenSnapshot | null {
  const p = path.join(SNAPSHOTS_DIR, `${id}.json`);
  if (!safeExistsSync(p)) return null;
  return readJson<GoldenSnapshot>(p);
}

function writeSnapshot(snapshot: GoldenSnapshot): void {
  withExecutionContext('ecosystem_architect', () => {
    if (!safeExistsSync(SNAPSHOTS_DIR)) safeMkdir(SNAPSHOTS_DIR, { recursive: true });
    const p = path.join(SNAPSHOTS_DIR, `${snapshot.pipeline_id}.json`);
    safeWriteFile(p, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8' });
  });
}

function elidePath(obj: any, dotPath: string): void {
  const parts = dotPath.split('.');
  if (parts.length === 0) return;
  if (parts.length === 1) {
    if (obj && typeof obj === 'object' && parts[0] in obj) delete obj[parts[0]];
    return;
  }
  if (obj && typeof obj === 'object' && parts[0] in obj) {
    elidePath(obj[parts[0]], parts.slice(1).join('.'));
  }
}

function normalizeResult(result: unknown, ignorePaths: string[]): unknown {
  if (result === null || result === undefined) return result;
  const cloned = JSON.parse(JSON.stringify(result));
  for (const p of [...DEFAULT_IGNORE_PATHS, ...ignorePaths]) {
    elidePath(cloned, p);
  }
  return cloned;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalize(v)).join(',') + '}';
}

function hashResult(result: unknown): string {
  return createHash('sha256').update(canonicalize(result)).digest('hex');
}

async function runPipeline(
  pipelinePath: string,
  input: Record<string, unknown> = {}
): Promise<unknown> {
  // Lazy-import to keep CLI startup fast and to allow the script to load without a
  // built dist/ when only the registry is being inspected.
  const mod = await import('./run_pipeline.js' as string);
  const executePipelineFileFn = (mod as Record<string, unknown>).executePipelineFile;
  if (typeof executePipelineFileFn !== 'function') {
    throw new Error('run_pipeline.js does not export executePipelineFile');
  }
  // Golden checks must exercise the same validated ADF lifecycle as production
  // execution. Calling runSteps directly bypassed pipeline schema/guardrail
  // validation and the canonical auto-repair hand-off.
  return await (
    executePipelineFileFn as (
      inputPath: string,
      options?: { context?: Record<string, unknown>; quiet?: boolean }
    ) => Promise<unknown>
  )(path.join(ROOT, pipelinePath), { context: input, quiet: true });
}

interface Diagnostic {
  pipeline_id: string;
  severity: 'error' | 'warning';
  message: string;
}

async function checkOne(entry: GoldenRegistryEntry, rebaseline: boolean): Promise<Diagnostic[]> {
  const diags: Diagnostic[] = [];
  let result: unknown;
  try {
    result = await runPipeline(entry.pipeline, entry.input ?? {});
  } catch (err: any) {
    diags.push({
      pipeline_id: entry.id,
      severity: 'error',
      message: `Pipeline run failed: ${err?.message ?? err}`,
    });
    return diags;
  }

  const normalized = normalizeResult(result, entry.ignore_paths ?? []);
  const newHash = hashResult(normalized);
  const newSnap: GoldenSnapshot = {
    generated_at: nowIso(),
    pipeline_id: entry.id,
    pipeline_path: entry.pipeline,
    result_hash: newHash,
    result: normalized,
  };

  if (rebaseline) {
    writeSnapshot(newSnap);
    return [];
  }

  const old = loadSnapshot(entry.id);
  if (!old) {
    writeSnapshot(newSnap);
    diags.push({
      pipeline_id: entry.id,
      severity: 'warning',
      message: `No snapshot existed. Created initial snapshot at tests/golden/snapshots/${entry.id}.json — commit it.`,
    });
    return diags;
  }

  if (old.result_hash !== newHash) {
    diags.push({
      pipeline_id: entry.id,
      severity: 'error',
      message:
        `Output changed. Compare tests/golden/snapshots/${entry.id}.json with the current run. ` +
        `If the change is intentional, run with --rebaseline. Old hash: ${old.result_hash}, new: ${newHash}.`,
    });
  }
  return diags;
}

export const runCheckGoldenOutput = defineScript({
  name: 'check:golden',
  flags: [],
  async run(context) {
    const args = context.argv;
    const rebaseline = args.includes('--rebaseline');

    const registry = loadRegistry();
    if (registry.length === 0) {
      context.print(
        `📝 No golden registry yet. Create ${path.relative(ROOT, REGISTRY_PATH)} ` +
          `with the pipelines you want gated. Example shape is in docs/developer/GOLDEN_OUTPUT_CHECK.md.`
      );
      return;
    }

    const allDiags: Diagnostic[] = [];
    for (const entry of registry) {
      const diags = await checkOne(entry, rebaseline);
      allDiags.push(...diags);
      const status = diags.find((d) => d.severity === 'error')
        ? '❌'
        : diags.length > 0
          ? '⚠️ '
          : '✅';
      context.print(`  ${status}  ${entry.id} (${entry.pipeline})`);
    }

    const errors = allDiags.filter((d) => d.severity === 'error');
    const warnings = allDiags.filter((d) => d.severity === 'warning');

    if (warnings.length > 0) {
      context.print('\nWarnings:');
      for (const w of warnings) context.print(`  - ${w.pipeline_id}: ${w.message}`);
    }
    if (errors.length > 0) {
      throw new ScriptExitError(
        1,
        ['\nErrors:', ...errors.map((error) => `  - ${error.pipeline_id}: ${error.message}`)].join(
          '\n'
        )
      );
    }

    if (rebaseline) {
      context.print(`\n✅ Rebaselined ${registry.length} snapshots.`);
    } else {
      context.print(`\n✅ Golden output check passed (${registry.length} pipelines).`);
    }
    return { registry: registry.length, warnings, errors, rebaseline };
  },
});

if (
  isDirectScript(import.meta.url, 'check_golden_output.ts') ||
  isDirectScript(import.meta.url, 'check_golden_output.js')
)
  void runCheckGoldenOutput();
