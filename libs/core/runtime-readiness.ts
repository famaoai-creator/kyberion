/**
 * runtime-readiness seam — Kubernetes/Docker-style readiness for a Kyberion
 * runtime, as opposed to liveness.
 *
 * `/api/healthz` (liveness) only says the process serves requests. Readiness
 * answers "can this runtime do governed work right now?": its durable runtime
 * floor exists, governed seam policy loads, the VCS backend resolves. An
 * orchestrator routes traffic only to ready replicas and restarts ones that
 * stay unready, instead of an operator reading `pnpm doctor` text.
 *
 * Checks are providers on a named seam, so a subsystem that adds a hard
 * dependency (a remote storage backend, a distributed lease store) registers
 * its own check instead of editing a central list. Every check is cheap,
 * side-effect free and bounded by a timeout; a throwing or slow check counts
 * as not ready.
 *
 * The report is designed to be served unauthenticated: it carries check ids
 * and booleans only. A check's diagnostic `detail` is for in-process callers
 * (`pnpm doctor`, the authenticated ops console) and is dropped by
 * {@link toPublicReadinessReport}.
 */

import { createProviderRegistry } from './provider/provider-registry.js';
import type { SeamProviderMetadata } from './seam.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { listSeamSelectionPolicies } from './seam-provider-selection.js';
import { resolveVcsBackend } from './vcs/vcs-backend.js';
import './vcs/local-git-backend.js';

export const RUNTIME_READINESS_SEAM = 'runtime-readiness-check';
export const DEFAULT_READINESS_CHECK_TIMEOUT_MS = 2_000;

export interface ReadinessCheckResult {
  ok: boolean;
  /** Operator diagnostic; never served on the public probe. */
  detail?: string;
}

export interface ReadinessCheck {
  readonly id: string;
  run(): Promise<ReadinessCheckResult> | ReadinessCheckResult;
}

export interface ReadinessReport {
  ready: boolean;
  checked_at: string;
  checks: Array<{ id: string; ok: boolean; detail?: string }>;
}

export interface PublicReadinessReport {
  ready: boolean;
  checks: Record<string, boolean>;
}

const readinessRegistry = createProviderRegistry<ReadinessCheck>({
  seam: RUNTIME_READINESS_SEAM,
  owner: 'libs/core/runtime-readiness.ts',
  source: 'runtime-readiness-extension',
  missingIdError: 'ReadinessCheck must have a non-empty id',
});

export function registerReadinessCheck(
  check: ReadinessCheck,
  metadata?: SeamProviderMetadata
): () => void {
  return readinessRegistry.register(check, metadata);
}

export function listReadinessChecks(): ReadinessCheck[] {
  return readinessRegistry.list();
}

export function resetReadinessChecks(): void {
  readinessRegistry.reset();
}

function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<ReadinessCheckResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, detail: `timed out after ${timeoutMs}ms` }),
      timeoutMs
    );
    timer.unref?.();
    Promise.resolve()
      .then(() => check.run())
      .then(
        (result) => resolve({ ok: result.ok === true, detail: result.detail }),
        (err) => resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) })
      )
      .finally(() => clearTimeout(timer));
  });
}

export async function evaluateRuntimeReadiness(
  options: { checks?: ReadinessCheck[]; timeoutMs?: number; now?: () => Date } = {}
): Promise<ReadinessReport> {
  const checks = options.checks ?? readinessRegistry.list();
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_CHECK_TIMEOUT_MS;
  const results = await Promise.all(
    checks.map(async (check) => ({ id: check.id, ...(await withTimeout(check, timeoutMs)) }))
  );
  return {
    // No registered checks means nothing vouches for the runtime: not ready.
    ready: results.length > 0 && results.every((result) => result.ok),
    checked_at: (options.now?.() ?? new Date()).toISOString(),
    checks: results.map((result) =>
      result.detail === undefined
        ? { id: result.id, ok: result.ok }
        : { id: result.id, ok: result.ok, detail: result.detail }
    ),
  };
}

/** Data-free projection for unauthenticated probes: ids and booleans only. */
export function toPublicReadinessReport(report: ReadinessReport): PublicReadinessReport {
  return {
    ready: report.ready,
    checks: Object.fromEntries(report.checks.map((check) => [check.id, check.ok])),
  };
}

// ─── Builtin checks ──────────────────────────────────────────────────────────

export const BUILTIN_READINESS_CHECKS: readonly ReadinessCheck[] = [
  {
    id: 'runtime-storage',
    run() {
      const runtimeRoot = pathResolver.shared('runtime');
      if (!safeExistsSync(runtimeRoot)) {
        return { ok: false, detail: 'active/shared/runtime is missing — run onboarding' };
      }
      return safeLstat(runtimeRoot).isDirectory()
        ? { ok: true }
        : { ok: false, detail: 'active/shared/runtime is not a directory' };
    },
  },
  {
    id: 'seam-policy',
    run() {
      const policies = listSeamSelectionPolicies();
      return policies.length > 0
        ? { ok: true }
        : { ok: false, detail: 'no governed seam-provider-selection policy loaded' };
    },
  },
  {
    id: 'vcs-backend',
    run() {
      return { ok: true, detail: `resolved ${resolveVcsBackend().id}` };
    },
  },
];

for (const check of BUILTIN_READINESS_CHECKS) {
  if (!readinessRegistry.get(check.id)) {
    registerReadinessCheck(check, { provenance: 'builtin', source: 'runtime-readiness' });
  }
}
