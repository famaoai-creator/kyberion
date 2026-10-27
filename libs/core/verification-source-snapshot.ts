import { createHash } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeReadFileSnapshot, safeRealpath } from './secure-io.js';
import { validateTaskSourcePaths } from './foundation/task-tool-grant-validation.js';

/** Bytes bound to a test execution, not an assertion that the tests passed. */
export interface VerificationSourceSnapshot {
  workspaceId: string;
  coverage: 'targeted' | 'full';
  sources: Array<{ path: string; sha256: string }>;
}
export interface VerificationFreshness {
  status: 'current' | 'partial' | 'stale' | 'unknown';
  coverage: 'targeted' | 'full' | 'unknown';
  checkedSources: number;
}

function workspaceId(): string {
  return createHash('sha256').update(safeRealpath(pathResolver.rootDir())).digest('hex');
}

export function parseVerificationSourceSnapshot(
  value: unknown
): VerificationSourceSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as VerificationSourceSnapshot;
  if (
    !/^[a-f0-9]{64}$/.test(record.workspaceId) ||
    !['targeted', 'full'].includes(record.coverage) ||
    !Array.isArray(record.sources) ||
    record.sources.length === 0 ||
    record.sources.length > 64
  )
    return undefined;
  try {
    const paths = validateTaskSourcePaths(record.sources.map((entry) => entry.path));
    if (
      paths.length !== record.sources.length ||
      record.sources.some((entry) => !/^[a-f0-9]{64}$/.test(entry.sha256))
    )
      return undefined;
    return {
      workspaceId: record.workspaceId,
      coverage: record.coverage,
      sources: record.sources.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    };
  } catch {
    return undefined;
  }
}

/** Call at the execution boundary. A report generator must never snapshot today's bytes for old tests. */
export function captureVerificationSourceSnapshot(
  paths: string[],
  coverage: 'targeted' | 'full' = 'targeted'
): VerificationSourceSnapshot {
  const sources = validateTaskSourcePaths(paths).map((source) => ({
    path: source,
    sha256: createHash('sha256')
      .update(safeReadFileSnapshot(pathResolver.rootResolve(source), 1_048_576))
      .digest('hex'),
  }));
  if (sources.length === 0)
    throw new Error('[VERIFICATION_SNAPSHOT_EMPTY] At least one exact source is required');
  return { workspaceId: workspaceId(), coverage, sources };
}

export function verificationFreshness(value: unknown): VerificationFreshness {
  const snapshot = parseVerificationSourceSnapshot(value);
  const unknown = {
    status: 'unknown',
    coverage: snapshot?.coverage ?? 'unknown',
    checkedSources: 0,
  } as const;
  if (!snapshot) return unknown;
  try {
    if (snapshot.workspaceId !== workspaceId()) return unknown;
    let mismatch = false;
    for (const source of snapshot.sources) {
      const hash = createHash('sha256')
        .update(safeReadFileSnapshot(pathResolver.rootResolve(source.path), 1_048_576))
        .digest('hex');
      if (hash !== source.sha256) mismatch = true;
    }
    return {
      status: mismatch ? 'stale' : snapshot.coverage === 'full' ? 'current' : 'partial',
      coverage: snapshot.coverage,
      checkedSources: snapshot.sources.length,
    };
  } catch {
    return unknown;
  }
}
