/**
 * state-probe — declarative external-state evaluation shared by dot `probe`
 * triggers and the `core:await_state` pipeline op.
 *
 * A probe answers "does this declared external state satisfy my expectation
 * right now?" without letting the declaration run code: the spec picks one
 * allowlisted probe type and the evaluator supplies the mechanics.
 *
 * - `file` probes are confined to the repository via secure-io (same rule as
 *   the charter `watch` trigger — a probe must not become a host oracle).
 * - `service_preset` probes call the governed service preset engine
 *   (`executeServicePreset`) through an injectable port, so this module stays
 *   free of actuator imports and is fully testable offline.
 *
 * `changed` expectations are evaluated against `deps.previousFingerprint` —
 * the caller owns the snapshot ledger (dot-probe-state.json / the suspended
 * run journal), keeping this module stateless.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { getZonedDateParts } from './pipeline/cron-utils.js';
import { isRecord } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeLstat, safeReadFile } from './secure-io.js';

export type StateProbeSpec =
  | {
      type: 'file';
      /** Repository-relative path. */
      path: string;
      expect: 'exists' | 'changed' | 'matches';
      /** Required when expect === 'matches'. */
      regex?: string;
    }
  | {
      type: 'service_preset';
      service_id: string;
      action: string;
      params?: Record<string, unknown>;
      expect?: {
        /** Dotted path into the result, e.g. 'pull.state' or 'items.0.id'. */
        json_path?: string;
        equals?: unknown;
        not_equals?: unknown;
        /** Fingerprint differs from the previous evaluation. */
        changed?: boolean;
      };
    };

export interface StateProbeResult {
  /** Whether the probe's expectation holds right now. */
  matched: boolean;
  /** The observed value (extracted via json_path when declared). */
  value?: unknown;
  /** Stable digest of the observed value — the caller's diff key. */
  fingerprint: string;
  detail?: string;
}

export interface StateProbeDeps {
  rootDir?: string;
  /** Injectable service-preset port; absent → service probes fail closed. */
  serviceCall?: (input: {
    service_id: string;
    action: string;
    params?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Fingerprint captured by the caller's last evaluation of this probe. */
  previousFingerprint?: string;
}

export const STATE_PROBE_TYPES = ['file', 'service_preset'] as const;

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

export function probeValueFingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex').slice(0, 24);
}

/** Stable identity of a probe spec — the caller's state-bucket key. */
export function probeSpecId(spec: StateProbeSpec): string {
  return createHash('sha256').update(stableSerialize(spec)).digest('hex').slice(0, 16);
}

function safeResolve(rel: string, rootDir: string | undefined): string {
  return assertSafeRepositoryPath(path.join(rootDir ?? pathResolver.rootDir(), rel), {
    allowMissingLeaf: true,
  });
}

function evaluateFileProbe(
  spec: Extract<StateProbeSpec, { type: 'file' }>,
  deps: StateProbeDeps
): StateProbeResult {
  const filePath = safeResolve(spec.path, deps.rootDir);
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    const s = safeLstat(filePath);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    stat = null;
  }
  const fingerprint = stat ? probeValueFingerprint(stat) : 'absent';
  if (spec.expect === 'exists') {
    return { matched: stat !== null, value: stat ?? undefined, fingerprint };
  }
  if (spec.expect === 'changed') {
    // 'changed' needs a baseline: the first evaluation only establishes it,
    // so activating a probe never produces a spurious wake on the current state.
    const matched =
      deps.previousFingerprint !== undefined &&
      stat !== null &&
      fingerprint !== deps.previousFingerprint;
    return {
      matched,
      value: stat ?? undefined,
      fingerprint,
      detail: stat === null ? 'file absent' : undefined,
    };
  }
  // expect === 'matches'
  if (!spec.regex) throw new Error("[PROBE] file probe expect 'matches' requires regex");
  if (stat === null) return { matched: false, fingerprint, detail: 'file absent' };
  const content = String(safeReadFile(filePath, { encoding: 'utf8' }));
  const re = new RegExp(spec.regex, 'm');
  return { matched: re.test(content), value: stat, fingerprint };
}

function extractJsonPath(value: unknown, jsonPath: string | undefined): unknown {
  if (!jsonPath) return value;
  let current: unknown = value;
  for (const segment of jsonPath.split('.')) {
    if (segment === '') continue;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

async function evaluateServicePresetProbe(
  spec: Extract<StateProbeSpec, { type: 'service_preset' }>,
  deps: StateProbeDeps
): Promise<StateProbeResult> {
  if (!deps.serviceCall) {
    // Fail closed: an uncallable service probe is "not satisfied", never an
    // error that would burn a trigger key on a misconfigured environment.
    return {
      matched: false,
      fingerprint: 'unavailable',
      detail: 'serviceCall port not configured',
    };
  }
  const raw = await deps.serviceCall({
    service_id: spec.service_id,
    action: spec.action,
    ...(spec.params ? { params: spec.params } : {}),
  });
  const value = extractJsonPath(raw, spec.expect?.json_path);
  const fingerprint = probeValueFingerprint(value);
  const expect = spec.expect ?? {};
  if (expect.changed === true) {
    return {
      matched: deps.previousFingerprint !== undefined && fingerprint !== deps.previousFingerprint,
      value,
      fingerprint,
    };
  }
  let matched = true;
  if ('equals' in expect) matched = stableSerialize(value) === stableSerialize(expect.equals);
  if (matched && 'not_equals' in expect) {
    matched = stableSerialize(value) !== stableSerialize(expect.not_equals);
  }
  return { matched, value, fingerprint };
}

export async function evaluateStateProbe(
  spec: StateProbeSpec,
  deps: StateProbeDeps = {}
): Promise<StateProbeResult> {
  if (!spec || typeof spec !== 'object') throw new Error('[PROBE] spec is required');
  switch (spec.type) {
    case 'file':
      return evaluateFileProbe(spec, deps);
    case 'service_preset':
      return evaluateServicePresetProbe(spec, deps);
    default:
      throw new Error(`[PROBE] unknown probe type: ${(spec as { type?: string }).type}`);
  }
}

/** Reuse the pipeline cron timezone parts for probe evaluation stamps. */
export function probeEvaluatedAtMinute(now: Date, timezone?: string): string {
  const parts = getZonedDateParts(now, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
