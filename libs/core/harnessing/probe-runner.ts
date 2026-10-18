/**
 * Isolated probe execution for contrastive harness tuning (harness2 import).
 *
 * One probe = one candidate overlay applied to a copy of the base scenario in
 * its own run dir under the run root. A probe whose scenario fails records a
 * RunOutcome — a dead rollout is evidence, not an exception. Spec-validation
 * errors (bad label, missing scenario, empty command) throw before any run.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertGovernedExec,
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeReadFile,
  safeRmSync,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '../secure-io.js';
import { logger } from '../core.js';
import { isValidRelPath } from './surface-spec.js';
import { scanOverlayForMarkers } from './leak-tripwire.js';
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
  /** Extra leak-tripwire markers — the STAGED SNAPSHOT is scanned before the
   *  command runs, so probed bytes == scanned bytes (live-dir scans have a
   *  TOCTOU gap between session-start scan and probe-time staging). */
  markers?: string[];
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
  /** Expected outputs that existed BEFORE the command ran (staged by the
   *  overlay OR shipped in the base scenario) — a non-empty list means
   *  `delivered` may not be earned by the command itself. */
  staged_expected: string[];
  /** Immutable copy of the overlay bytes that were actually staged into the
   *  run dir (runRoot/.snapshots/<label>). Adoption must source from THIS —
   *  the live overlayDir may have changed since the probe ran. Absent when
   *  the probe had no overlay (base run) or failed before staging. */
  staged_snapshot?: string;
  /** sha256 manifest of staged_snapshot captured AT STAGE TIME. The snapshot
   *  dir is reachable by the scenario (sibling of run dir, no fs sandbox),
   *  so adoption must re-verify this manifest before trusting the bytes. */
  snapshot_manifest?: Record<string, string>;
  error: string;
  recorded_at: string;
}

export function copyTree(src: string, dst: string): void {
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

/** Content manifest of every file under root: relpath → sha256 hex.
 *  Reads raw bytes — hashing the utf8-decoded string would map distinct
 *  byte sequences to the same replacement-char digest (invisible drift). */
export function treeManifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listFiles(root)) {
    out[rel] = createHash('sha256')
      .update(safeReadFile(path.join(root, rel), { encoding: null }))
      .digest('hex');
  }
  return out;
}

export function manifestsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function assertLabelSafe(label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(label)) {
    throw new Error(
      `[PROBE_LABEL_INVALID] label ${JSON.stringify(label)} must match [A-Za-z0-9][A-Za-z0-9_-]*`
    );
  }
}

export function validateProbeSpec(spec: Pick<ProbeSpec, 'command' | 'expectOutputs'>): void {
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
}

export function runProbe(spec: ProbeSpec): RunOutcome {
  assertLabelSafe(spec.label);
  const runRoot = assertSafeRepositoryPath(spec.runRoot, { allowMissingLeaf: true });
  const scenarioDir = assertSafeRepositoryPath(spec.scenarioDir);
  validateProbeSpec(spec);
  const scen = path.resolve(spec.scenarioDir);
  const resolvedRoot = path.resolve(runRoot);
  if (resolvedRoot === scen || resolvedRoot.startsWith(`${scen}${path.sep}`)) {
    throw new Error(
      '[PROBE_SPEC] runRoot must not equal or be nested inside scenarioDir (copyTree would recurse into itself)'
    );
  }
  const runDir = path.join(runRoot, spec.label);
  const resolvedRunDir = path.resolve(runDir);
  // Staging onto (or inside) the scenario would recurse the copy into itself
  // — or worse, safeRmSync a live scenario. Deterministic spec error, not evidence.
  if (
    resolvedRunDir === scen ||
    resolvedRunDir.startsWith(`${scen}${path.sep}`) ||
    scen.startsWith(`${resolvedRunDir}${path.sep}`)
  ) {
    throw new Error(
      '[PROBE_SPEC] run dir and scenarioDir must not nest inside each other (copyTree would recurse or delete input)'
    );
  }
  const recorded_at = nowIso();
  // Declared before `fail` so failure outcomes still report what was staged
  // (a partial/absent manifest signals an unverified snapshot).
  let overlay: string | null = null;
  let snapshotDir: string | null = null;
  let snapshotManifest: Record<string, string> | null = null;
  const fail = (error: string): RunOutcome => ({
    label: spec.label,
    run_dir: runDir,
    ok: false,
    delivered: false,
    staged_expected: [],
    exit_code: null,
    wall_ms: 0,
    produced_files: [],
    ...(snapshotDir ? { staged_snapshot: snapshotDir } : {}),
    ...(snapshotManifest ? { snapshot_manifest: snapshotManifest } : {}),
    error,
    recorded_at,
  });

  // All overlay validation happens BEFORE the first write — a rejected
  // overlay must not leave a partial run-dir tree inside the caller's input.
  if (spec.overlayDir) {
    overlay = assertSafeRepositoryPath(spec.overlayDir);
    if (!safeExistsSync(overlay) || !safeLstat(overlay).isDirectory()) {
      return fail(`overlay dir missing or not a directory: ${spec.overlayDir}`);
    }
    const resolvedOverlay = path.resolve(overlay);
    if (
      resolvedRunDir === resolvedOverlay ||
      resolvedRunDir.startsWith(`${resolvedOverlay}${path.sep}`) ||
      resolvedOverlay.startsWith(`${resolvedRunDir}${path.sep}`)
    ) {
      return fail(
        `overlay dir ${spec.overlayDir} and run dir ${runDir} nest inside each other — copyTree would recurse or delete input`
      );
    }
    // Frozen byte record of what this probe staged. Kept OUTSIDE the run dir
    // but inside runRoot (repo-scoped path contract). A sibling is still
    // reachable by the scenario via ../ or absolute paths — integrity comes
    // from the manifest below, verified again at adoption time, not from
    // placement alone.
    snapshotDir = path.join(runRoot, '.snapshots', spec.label);
    const resolvedSnapshot = path.resolve(snapshotDir);
    if (
      resolvedSnapshot === resolvedOverlay ||
      resolvedSnapshot.startsWith(`${resolvedOverlay}${path.sep}`) ||
      resolvedOverlay.startsWith(`${resolvedSnapshot}${path.sep}`)
    ) {
      return fail(
        `overlay dir ${spec.overlayDir} and snapshot dir nest inside each other — copyTree would recurse`
      );
    }
    // Spec error, not outcome: scenarioDir = runRoot/.snapshots[/label] would
    // be deleted-and-rewritten by staging — input destruction, not evidence.
    if (
      resolvedSnapshot === scen ||
      resolvedSnapshot.startsWith(`${scen}${path.sep}`) ||
      scen.startsWith(`${resolvedSnapshot}${path.sep}`)
    ) {
      throw new Error('[PROBE_SPEC] snapshot dir and scenarioDir must not nest inside each other');
    }
  }

  try {
    // A rerun of the same label must start empty: stale files from a prior
    // probe (including declared expectOutputs) would fake delivered=true.
    if (safeExistsSync(runDir)) safeRmSync(runDir);
    copyTree(scenarioDir, runDir);
    if (overlay && snapshotDir) {
      // Stage through the snapshot, not the live overlay: ONE read of the
      // mutable source, so the snapshot IS the probed bytes by construction.
      // A later overlayDir mutation cannot retro-edit what the probe ran.
      if (safeExistsSync(snapshotDir)) safeRmSync(snapshotDir);
      copyTree(overlay, snapshotDir);
      copyTree(snapshotDir, runDir);
      // Hash the staged bytes now — the scenario runs with cwd=runDir and no
      // fs sandbox, so a post-stage tamper of ../.snapshots must be detectable
      // at adoption time, not silently materialized.
      snapshotManifest = treeManifest(snapshotDir);
    }
  } catch (error) {
    return fail(`could not stage run dir: ${error instanceof Error ? error.message : error}`);
  }

  if (overlay && snapshotDir) {
    // Tripwire the exact bytes about to be probed — a mutation between a
    // caller's session-start scan and this stage cannot smuggle marker
    // content into the run dir or a later adoption.
    let scan;
    try {
      scan = scanOverlayForMarkers(snapshotDir, spec.markers);
    } catch (error) {
      return fail(
        `staged-snapshot marker scan failed: ${error instanceof Error ? error.message : error}`
      );
    }
    if (!scan.clean) {
      const h = scan.hits[0];
      return fail(`leak marker: ${h.marker} at ${h.path}:${h.line} (staged snapshot)`);
    }
  }

  const stagedBefore = new Set(listFiles(runDir));
  // Per-entry snapshot including directories — listFiles only returns files,
  // so a staged 'out/' dir would evade the staged_expected honesty check.
  const expectedPreStaged = (spec.expectOutputs ?? []).filter((rel) =>
    safeExistsSync(path.join(runDir, rel))
  );
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
  // An overlay that stages the expected outputs satisfies `delivered`
  // without the command producing anything — surface that honestly.
  const staged_expected = expectedPreStaged;
  // A candidate that merely staged every expected output earned nothing —
  // count it as not delivered so the axis can't auto_advance on the sham.
  const allStaged =
    (spec.expectOutputs?.length ?? 0) > 0 && staged_expected.length === spec.expectOutputs!.length;
  const delivered = exit_code === 0 && missing.length === 0 && !allStaged;
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
    staged_expected,
    ...(snapshotDir ? { staged_snapshot: snapshotDir } : {}),
    ...(snapshotManifest ? { snapshot_manifest: snapshotManifest } : {}),
    error: delivered
      ? ''
      : (allStaged ? 'all_expected_staged ' : '') +
        `exit=${exit_code}` +
        (missing.length ? ` missing=${missing.join(',')}` : '') +
        spawnError +
        (stderrTail ? ` stderr_tail=${stderrTail}` : ''),
    recorded_at,
  };
}
