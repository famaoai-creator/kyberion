import path from 'node:path';

import { customerRoot } from '@agent/core/customer-resolver';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import {
  normalizePersistedTrace,
  summarizePersistedTrace,
  type TraceFeedOptions,
} from './trace-feed';

export function traceLogRoots(): string[] {
  const roots: string[] = [pathResolver.shared('logs/traces')];
  const customerTraceRoot = customerRoot('logs/traces');
  if (customerTraceRoot) roots.unshift(customerTraceRoot);
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

export function isAllowedTraceLogPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || '').trim();
  if (!normalized) return false;
  if (!/\.jsonl$/i.test(normalized)) return false;

  const resolved = path.resolve(normalized);
  return traceLogRoots().some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
}

export function resolveSafeTraceLogPath(logicalPath: string): string | null {
  if (!isAllowedTraceLogPath(logicalPath)) return null;
  try {
    const resolved = assertSafeRepositoryPath(pathResolver.resolve(logicalPath));
    return safeExistsSync(resolved) && safeLstat(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Return only trace records visible to the already-resolved viewer. The raw
 * endpoint is line-oriented for the TraceViewer, but a shared JSONL file can
 * contain multiple tenants and tiers, so path validation alone is insufficient.
 */
export function filterTraceLogContent(
  content: string,
  tracePath: string,
  scope: Pick<TraceFeedOptions, 'tenantSlugs' | 'tierAccess'>
): string {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = normalizePersistedTrace(parseSafeJsonInput(trimmed, 'trace log entry'), {
        strictUnknownSpans: true,
      });
      if (!parsed) continue;
      const summary = summarizePersistedTrace(parsed, tracePath);
      if (!summary) continue;
      if (
        scope.tenantSlugs !== undefined &&
        scope.tenantSlugs !== 'all' &&
        (!summary.tenantSlug || !scope.tenantSlugs.includes(summary.tenantSlug))
      ) {
        continue;
      }
      if (
        scope.tierAccess !== undefined &&
        (!summary.tier || !scope.tierAccess.includes(summary.tier))
      ) {
        continue;
      }
      lines.push(trimmed);
    } catch {
      // Never expose malformed or unclassified raw lines through the surface.
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
