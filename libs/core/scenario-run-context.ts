/**
 * ES-03: isolated scenario run context.
 *
 * Each scenario run gets its own root directory
 * (`active/shared/tmp/scenarios/<run-id>-<nonce>`), a deterministic id derived
 * from the scenario id (so re-running the same scenario reproduces the same
 * run id and content-addressed sub-ids), and a virtual clock started at the
 * scenario's seed clock (or a fixed epoch when unspecified). The
 * interceptor/runner (later waves) build their observation and fixture
 * lookups on top of this context.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { ensureDir, safeExistsSync, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { createVirtualClock, type VirtualClock } from './foundation/clock.js';
import { parseIso } from './foundation/time.js';
import type { ScenarioDefinition } from './scenario-definition.js';

/** Deterministic default start time for scenarios that don't declare seed.clock.start_iso. */
const FIXED_EPOCH_MS = Date.UTC(2020, 0, 1);

let rootInvocationCounter = 0;

/**
 * The run id stays deterministic for reports and derived ids, but the root
 * is per invocation: a rerun never sees a previous run's files and two
 * concurrent runs of one scenario never share (or delete) a root.
 */
function invocationNonce(): string {
  rootInvocationCounter += 1;
  return `${process.pid.toString(36)}-${rootInvocationCounter.toString(36)}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

export interface ScenarioRunContextOptions {
  /** Distinguishes concurrent runs of the same scenario id; defaults to 'default'. */
  seedNonce?: string;
  /** Skip dispose()'s directory removal (useful for debugging a failed run). */
  keep?: boolean;
  /** Override the computed run root (tests only — must stay inside a governed write area). */
  rootOverride?: string;
}

export interface ScenarioRunContext {
  readonly runId: string;
  /** Per-invocation root (`scenarios/<runId>-<nonce>`), never shared between runs. */
  readonly runRoot: string;
  /** Deterministic UUID-shaped id, stable for the same (runId, namespace, n) triple. */
  deterministicId(namespace: string, n: number | string): string;
  readonly clock: VirtualClock;
  /** Reset runRoot to empty, then write seed.files under it. */
  materializeSeedFiles(): void;
  /** Remove runRoot unless `keep` was set. */
  dispose(): void;
}

function computeRunId(scenarioId: string, seedNonce: string | undefined): string {
  return crypto
    .createHash('sha256')
    .update(`${scenarioId}:${seedNonce ?? 'default'}`)
    .digest('hex')
    .slice(0, 16);
}

/** RFC4122-shaped (version 5, variant 10) formatting of a sha1 digest — not namespace-UUID-derived, just UUID-shaped and deterministic. */
function formatAsUuidV5(sha1Hex: string): string {
  const bytes = sha1Hex
    .slice(0, 32)
    .match(/.{2}/g)!
    .map((byte) => Number.parseInt(byte, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function computeDeterministicId(runId: string, namespace: string, n: number | string): string {
  const digest = crypto.createHash('sha1').update(`${runId}:${namespace}:${n}`).digest('hex');
  return formatAsUuidV5(digest);
}

/** Defense-in-depth mirror of scenario-definition.ts's seed file containment check. */
function assertContainedUnderRoot(runRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).some((s) => s === '..')) {
    throw new Error(`[SCENARIO_RUN_CONTEXT] seed file path escapes the run root: ${relativePath}`);
  }
  const resolved = path.resolve(runRoot, relativePath);
  const relativeToRoot = path.relative(runRoot, resolved);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`[SCENARIO_RUN_CONTEXT] seed file path escapes the run root: ${relativePath}`);
  }
  return resolved;
}

export function createScenarioRunContext(
  def: ScenarioDefinition,
  options: ScenarioRunContextOptions = {}
): ScenarioRunContext {
  const runId = computeRunId(def.id, options.seedNonce);
  const runRoot = options.rootOverride
    ? pathResolver.resolve(options.rootOverride)
    : pathResolver.sharedTmp(`scenarios/${runId}-${invocationNonce()}`);

  const startMs = def.seed.clock?.start_iso
    ? parseIso(def.seed.clock.start_iso).getTime()
    : FIXED_EPOCH_MS;
  const clock = createVirtualClock(startMs);

  function materializeSeedFiles(): void {
    if (safeExistsSync(runRoot)) safeRmSync(runRoot);
    ensureDir(runRoot);
    for (const file of def.seed.files ?? []) {
      const target = assertContainedUnderRoot(runRoot, file.path);
      safeWriteFile(target, file.content);
    }
  }

  function dispose(): void {
    if (options.keep) return;
    if (safeExistsSync(runRoot)) safeRmSync(runRoot);
  }

  return {
    runId,
    runRoot,
    deterministicId: (namespace: string, n: number | string) =>
      computeDeterministicId(runId, namespace, n),
    clock,
    materializeSeedFiles,
    dispose,
  };
}
