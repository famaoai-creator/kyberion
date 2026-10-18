/**
 * Isolated probe execution for contrastive harness tuning (harness2 import).
 *
 * One probe = one candidate overlay applied to a copy of the base scenario in
 * its own run dir under the run root. A probe whose scenario fails records a
 * RunOutcome — a dead rollout is evidence, not an exception. Spec-validation
 * errors (bad label, missing scenario, empty command) throw before any run.
 */

import * as path from 'node:path';
import {
  assertGovernedExec,
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeRmSync,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '../secure-io.js';
import { logger } from '../core.js';
import { isValidRelPath } from './surface-spec.js';
import { nowIso } from '../foundation/time.js';

export interface ProbeSpec {
  /** Candidate label, e.g. 'base', 'inv1', 'dom1'. */
  label: string;
  /** Directory holding the base workspace the scenario runs against. */
  scenarioDir: string;
  /** Optional overlay: files copied over the base copy. Absent = unmodified base. */
  overlayDir?: string;
  /** Scenario command: argv form, executed with cwd = run dir. shell:false. */
  command: string[];
  /** Relative paths that must exist after the command for `delivered`. */
  expectOutputs?: string[];
  /** Parent directory for the per-candidate run dirs (repo-scoped). */
  runRoot: string;
  timeoutMs?: number;
}

export interface RunOutcome {
  label: string;
  run_dir: string;
  /** The probe itself ran to completion (command invoked, run dir produced). */
  ok: boolean;
  /** The scenario produced its expected artifacts. */
  delivered: boolean;
  exit_code: number | null;
  wall_ms: number;
  produced_files: string[];
  error: string;
  recorded_at: string;
}

function copyTree(src: string, dst: string): void {
  safeMkdir(dst, { recursive: true });
  for (const entry of safeReaddir(src)) {
    const s = path.join(src, entry);
    const d = path.join(dst, entry);
    const stat = safeLstat(s);
    if (stat.isDirectory()) copyTree(s, d);
    else if (stat.isFile()) safeCopyFileSync(s, d);
  }
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  if (!safeExistsSync(dir)) return out;
  for (const entry of safeReaddir(dir).sort()) {
    const p = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const stat = safeLstat(p);
    if (stat.isDirectory()) out.push(...listFiles(p, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

function assertLabelSafe(label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) {
    throw new Error(
      `[PROBE_LABEL_INVALID] label ${JSON.stringify(label)} must match [A-Za-z0-9][A-Za-z0-9_-]*`
    );
  }
}

export function runProbe(spec: ProbeSpec): RunOutcome {
  assertLabelSafe(spec.label);
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  const scenarioDir = assertSafeRepositoryPath(spec.scenarioDir);
  if (!spec.command.length) {
    throw new Error('[PROBE_SPEC] command must be a non-empty argv array');
  }
  // Command policy violations are spec errors, not rollout evidence.
  assertGovernedExec(spec.command[0], spec.command.slice(1));
  // expectOutputs paths are checked INSIDE the run dir — a traversal entry
  // like '../../x' would escape it and let an unrelated file fake delivered.
  for (const rel of spec.expectOutputs ?? []) {
    if (!isValidRelPath(rel)) {
      throw new Error(`[PROBE_SPEC] invalid expectOutputs path ${JSON.stringify(rel)}`);
    }
  }
  const runDir = path.join(runRoot, spec.label);
  const recorded_at = nowIso();
  const fail = (error: string): RunOutcome => ({
    label: spec.label,
    run_dir: runDir,
    ok: false,
    delivered: false,
    exit_code: null,
    wall_ms: 0,
    produced_files: [],
    error,
    recorded_at,
  });

  try {
    // A rerun of the same label must start empty: stale files from a prior
    // probe (including declared expectOutputs) would fake delivered=true.
    if (safeExistsSync(runDir)) safeRmSync(runDir);
    copyTree(scenarioDir, runDir);
    if (spec.overlayDir) {
      const overlay = assertSafeRepositoryPath(spec.overlayDir);
      if (!safeExistsSync(overlay) || !safeLstat(overlay).isDirectory()) {
        return fail(`overlay dir missing or not a directory: ${spec.overlayDir}`);
      }
      copyTree(overlay, runDir);
    }
  } catch (error) {
    return fail(`could not stage run dir: ${error instanceof Error ? error.message : error}`);
  }

  const stagedBefore = new Set(listFiles(runDir));
  const started = Date.now();
  let result;
  try {
    result = safeExecResult(spec.command[0], spec.command.slice(1), {
      cwd: runDir,
      timeoutMs: spec.timeoutMs ?? 120_000,
    });
  } catch (error) {
    return fail(`command failed to start: ${error instanceof Error ? error.message : error}`);
  }
  const wall_ms = Date.now() - started;
  const stderrTail = String(result.stderr || '')
    .trim()
    .split('\n')
    .slice(-5)
    .join('\n')
    .slice(0, 500);
  const spawnError = result.error ? ` spawn=${result.error.message}` : '';
  const exit_code = typeof result.status === 'number' ? result.status : null;
  const after = listFiles(runDir);
  const missing = (spec.expectOutputs ?? []).filter(
    (rel) => !safeExistsSync(path.join(runDir, rel))
  );
  const delivered = exit_code === 0 && missing.length === 0;
  logger.debug?.(
    `[probe:${spec.label}] exit=${exit_code} delivered=${delivered} wall=${wall_ms}ms`
  );
  return {
    label: spec.label,
    run_dir: runDir,
    ok: true,
    delivered,
    exit_code,
    wall_ms,
    produced_files: after.filter((f) => !stagedBefore.has(f)),
    error: delivered
      ? ''
      : `exit=${exit_code}` +
        (missing.length ? ` missing=${missing.join(',')}` : '') +
        spawnError +
        (stderrTail ? ` stderr_tail=${stderrTail}` : ''),
    recorded_at,
  };
}
