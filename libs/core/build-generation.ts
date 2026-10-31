/**
 * Build-generation receipt (kyberion-reliability R12).
 *
 * One JSON document describes the compiler generation that produced the
 * current `dist/` tree: which inputs went in, which tools ran, and whether
 * the input set stayed stable while the build ran. It lives inside `dist/`
 * itself (`dist/.build-generation.json`) — the same governed floor and the
 * same lifetime as the `dist/.session-build-head` stamp the agent-worktree
 * tooling already writes — so the receipt dies with the outputs it describes
 * (`pnpm clean`, a foreign dist swap) instead of outliving them.
 *
 * Publication rules (enforced here, callers cannot weaken them):
 *
 *  - Only a *completed* generation observed against a *stable* input set may
 *    be published. Failed / aborted / concurrent-modified builds never
 *    overwrite the last good receipt.
 *  - Writes go through `safeWriteFile`, which publishes atomically
 *    (temp + rename), so readers never see a torn receipt.
 *  - A receipt is evidence, not authority: a present receipt never makes a
 *    build fresh by itself — the input/emit scan re-judges every time.
 *  - No secrets, no environment dumps: tool versions and hashes only.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import type { BuildGenerationIdentity } from './build-readiness.js';

export const BUILD_RECEIPT_SCHEMA_VERSION = 1;
export const BUILD_GENERATION_RECEIPT_FILENAME = '.build-generation.json';
// Mirrors libs/core/workforce/agent-worktree.ts `DIST_BUILD_STAMP`; the stamp
// stays owned by that module — it is read here only as legacy generation
// evidence, never written.
const DIST_BUILD_STAMP_FILENAME = '.session-build-head';

/** How the input set behaved while the build ran. `stable_observed` honestly
 *  means "before/after fingerprints matched" — it cannot prove an A→B→A
 *  change did not happen, and never claims isolation. */
export type BuildInputStability = 'stable_observed' | 'changed_observed' | 'unverifiable';

export interface BuildToolVersions {
  node: string;
  typescript?: string;
  pnpm?: string;
}

export interface BuildGenerationReceipt {
  schemaVersion: typeof BUILD_RECEIPT_SCHEMA_VERSION;
  /** Unique id of this completed generation (the build attempt id). */
  generationId: string;
  mode: 'all' | 'packages' | 'repo';
  startedAt: string;
  finishedAt: string;
  result: 'completed';
  /** sha256 over the compiler input set (source contents + membership). */
  inputFingerprint: string;
  /** sha256 over tsconfig / manifests / lockfile / compiler identity. */
  configFingerprint: string;
  toolVersions: BuildToolVersions;
  inputStability: 'stable_observed';
}

export type BuildReceiptRead =
  | { status: 'none' }
  | { status: 'valid'; receipt: BuildGenerationReceipt }
  | { status: 'legacy'; detail: string }
  | { status: 'invalid'; detail: string };

export function buildGenerationReceiptPath(distDir?: string): string {
  return path.join(distDir ?? pathResolver.rootResolve('dist'), BUILD_GENERATION_RECEIPT_FILENAME);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseReceipt(value: unknown): BuildGenerationReceipt | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const tools = candidate.toolVersions as Record<string, unknown> | undefined;
  if (
    candidate.schemaVersion !== BUILD_RECEIPT_SCHEMA_VERSION ||
    !isNonEmptyString(candidate.generationId) ||
    (candidate.mode !== 'all' && candidate.mode !== 'packages' && candidate.mode !== 'repo') ||
    !isNonEmptyString(candidate.startedAt) ||
    !isNonEmptyString(candidate.finishedAt) ||
    candidate.result !== 'completed' ||
    !isNonEmptyString(candidate.inputFingerprint) ||
    !isNonEmptyString(candidate.configFingerprint) ||
    typeof tools !== 'object' ||
    tools === null ||
    !isNonEmptyString(tools.node) ||
    candidate.inputStability !== 'stable_observed'
  ) {
    return null;
  }
  return {
    schemaVersion: BUILD_RECEIPT_SCHEMA_VERSION,
    generationId: candidate.generationId,
    mode: candidate.mode,
    startedAt: candidate.startedAt,
    finishedAt: candidate.finishedAt,
    result: 'completed',
    inputFingerprint: candidate.inputFingerprint,
    configFingerprint: candidate.configFingerprint,
    toolVersions: {
      node: tools.node,
      ...(isNonEmptyString(tools.typescript) ? { typescript: tools.typescript } : {}),
      ...(isNonEmptyString(tools.pnpm) ? { pnpm: tools.pnpm } : {}),
    },
    inputStability: 'stable_observed',
  };
}

/**
 * Read the generation receipt for a dist tree. Missing → `none`; a
 * well-formed document that is not schemaVersion 1 → `legacy`; anything else
 * unreadable/malformed → `invalid`. Legacy and invalid are never silently
 * treated as proof of a good generation.
 */
export function readBuildGenerationReceipt(distDir?: string): BuildReceiptRead {
  const receiptPath = buildGenerationReceiptPath(distDir);
  if (!safeExistsSync(receiptPath)) return { status: 'none' };
  let raw: string;
  try {
    raw = safeReadFile(receiptPath, { encoding: 'utf8' }) as string;
  } catch (error) {
    return {
      status: 'invalid',
      detail: `receipt unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', detail: 'receipt is not valid JSON' };
  }
  const schemaVersion = (parsed as Record<string, unknown>)?.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== BUILD_RECEIPT_SCHEMA_VERSION) {
    return {
      status: 'legacy',
      detail: `receipt schemaVersion ${String(schemaVersion)} is not ${BUILD_RECEIPT_SCHEMA_VERSION}`,
    };
  }
  const receipt = parseReceipt(parsed);
  if (!receipt) {
    return { status: 'invalid', detail: 'receipt is missing required generation fields' };
  }
  return { status: 'valid', receipt };
}

/**
 * Publish a completed-generation receipt atomically. Refuses anything that is
 * not a verified completed generation over a stable input set — failed,
 * aborted or concurrent-modified builds must never overwrite the last good
 * receipt, so callers simply do not call this for them.
 */
export function publishBuildGenerationReceipt(
  receipt: BuildGenerationReceipt,
  distDir?: string
): void {
  if (receipt.result !== 'completed' || receipt.inputStability !== 'stable_observed') {
    throw new Error(
      'refusing to publish a build-generation receipt that is not a completed, stable-input generation'
    );
  }
  safeWriteFile(buildGenerationReceiptPath(distDir), JSON.stringify(receipt, null, 2) + '\n');
}

/**
 * Resolve the best available generation identity for the current dist tree:
 * a valid receipt → `receipt`; an unreadable/out-of-schema one →
 * `legacy_receipt`; otherwise the agent-worktree `.session-build-head` stamp
 * → `stamp`; nothing → `none`.
 */
export function readBuildGenerationIdentity(distDir?: string): BuildGenerationIdentity {
  const receipt = readBuildGenerationReceipt(distDir);
  if (receipt.status === 'valid') {
    return {
      provenance: 'receipt',
      receiptId: receipt.receipt.generationId,
      sourceFingerprint: receipt.receipt.inputFingerprint,
    };
  }
  if (receipt.status === 'legacy' || receipt.status === 'invalid') {
    return { provenance: 'legacy_receipt', detail: receipt.detail };
  }
  const stampPath = path.join(
    distDir ?? pathResolver.rootResolve('dist'),
    DIST_BUILD_STAMP_FILENAME
  );
  if (safeExistsSync(stampPath)) {
    try {
      const head = (safeReadFile(stampPath, { encoding: 'utf8' }) as string).trim();
      if (head) return { provenance: 'stamp', head };
    } catch {
      /* fall through to none */
    }
  }
  return { provenance: 'none' };
}
