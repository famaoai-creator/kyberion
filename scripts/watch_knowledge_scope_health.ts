#!/usr/bin/env node
/** KO-18: deterministic health report for registered tenant knowledge roots. */
import * as path from 'node:path';
import {
  buildTenantKnowledgeScopeSet,
  listTenantProfileSlugs,
  pathResolver,
  resolveTenant,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeStat,
  sendOpsAlert,
  withExecutionContext,
  type OpsAlertInput,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { getRegisteredEnvText } from '@agent/core/foundation';

type HealthRow = {
  tenant_slug: string;
  status: 'healthy' | 'attention';
  knowledge_root?: string;
  knowledge_root_exists: boolean;
  allowlisted_roots: string[];
  reason?: string;
};

export type KnowledgeScopeHealthReport = {
  generated_at: string;
  status: 'healthy' | 'attention';
  summary: {
    registered_tenants: number;
    healthy: number;
    attention: number;
    legacy_unscoped_file_count: number;
    legacy_unscoped_growth: number;
    legacy_unscoped_oldest_age_days: number | null;
    legacy_quarantine_ttl_days: number;
  };
  alerts: Array<{
    code: 'missing_knowledge_root' | 'empty_allowlist' | 'legacy_growth' | 'legacy_ttl_breach';
    tenant_slug?: string;
    message: string;
  }>;
  tenants: HealthRow[];
};

export interface LegacyUnscopedFile {
  path: string;
  mtime_ms: number;
}

export function evaluateLegacyQuarantine(
  files: LegacyUnscopedFile[],
  nowMs = Date.now(),
  ttlDays = 14
): {
  count: number;
  oldest_age_days: number | null;
  ttl_breached: boolean;
} {
  const valid = files.filter((file) => Number.isFinite(file.mtime_ms));
  const oldest = valid.length > 0 ? Math.min(...valid.map((file) => file.mtime_ms)) : undefined;
  const oldestAge = oldest === undefined ? null : Math.max(0, (nowMs - oldest) / 86_400_000);
  return {
    count: files.length,
    oldest_age_days: oldestAge === null ? null : Math.floor(oldestAge),
    ttl_breached: oldestAge !== null && oldestAge > Math.max(0, ttlDays),
  };
}

function legacyQuarantineTtlDays(): number {
  const policyPath = pathResolver.knowledge('product/governance/knowledge-scope-check.json');
  try {
    const parsed = JSON.parse(String(safeReadFile(policyPath, { encoding: 'utf8' }))) as {
      legacy_quarantine_ttl_days?: unknown;
    };
    return typeof parsed.legacy_quarantine_ttl_days === 'number' &&
      parsed.legacy_quarantine_ttl_days >= 0
      ? parsed.legacy_quarantine_ttl_days
      : 14;
  } catch {
    return 14;
  }
}

function healthHistoryPath(): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_SCOPE_HEALTH_HISTORY_PATH')?.trim();
  return override
    ? pathResolver.rootResolve(override)
    : pathResolver.shared('runtime/feedback-loop/knowledge-scope-health.json');
}

function listLegacyUnscopedFiles(): LegacyUnscopedFile[] {
  const root = pathResolver.shared('runtime/feedback-loop');
  if (!safeExistsSync(root)) return [];
  return getAllFiles(root)
    .filter((filePath) => {
      const relative = path.relative(root, filePath).replace(/\\/g, '/');
      return (
        relative !== '' && relative.endsWith('.jsonl') && !relative.split('/').includes('tenants')
      );
    })
    .flatMap((filePath) => {
      try {
        return [{ path: filePath, mtime_ms: safeStat(filePath).mtimeMs }];
      } catch {
        return [];
      }
    });
}

function readPriorLegacyCount(): number | undefined {
  const filePath = healthHistoryPath();
  if (!safeExistsSync(filePath)) return undefined;
  try {
    const value = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as {
      legacy_unscoped_file_count?: unknown;
    };
    return typeof value.legacy_unscoped_file_count === 'number'
      ? value.legacy_unscoped_file_count
      : undefined;
  } catch {
    return undefined;
  }
}

function persistLegacyCount(count: number, generatedAt: string): void {
  const filePath = healthHistoryPath();
  const parent = path.dirname(filePath);
  if (!safeExistsSync(parent)) {
    safeMkdir(parent, { recursive: true });
  }
  safeWriteFile(
    filePath,
    JSON.stringify({ generated_at: generatedAt, legacy_unscoped_file_count: count }, null, 2) + '\n'
  );
}

function scanRows(): HealthRow[] {
  return withExecutionContext('ecosystem_architect', () => {
    const result: HealthRow[] = [];
    for (const tenantSlug of listTenantProfileSlugs()) {
      try {
        const resolved = resolveTenant(tenantSlug);
        const root = pathResolver.rootResolve(resolved.knowledge_root);
        const scopeSet = buildTenantKnowledgeScopeSet(tenantSlug);
        const exists = safeExistsSync(root);
        result.push({
          tenant_slug: tenantSlug,
          status: exists && scopeSet ? 'healthy' : 'attention',
          knowledge_root: resolved.knowledge_root,
          knowledge_root_exists: exists,
          allowlisted_roots:
            scopeSet?.scopes.map(
              (scope) => `${scope.tiers.join('+')}:${scope.customerId || 'shared'}`
            ) || [],
          ...(!exists ? { reason: 'registered knowledge_root does not exist' } : {}),
          ...(!scopeSet ? { reason: 'tenant cannot produce a positive retrieval allowlist' } : {}),
        });
      } catch (error) {
        result.push({
          tenant_slug: tenantSlug,
          status: 'attention',
          knowledge_root_exists: false,
          allowlisted_roots: [],
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  });
}

export function scanKnowledgeScopeHealth(
  options: { persistHistory?: boolean } = {}
): KnowledgeScopeHealthReport {
  const generatedAt = new Date().toISOString();
  const rows = scanRows();
  const legacyFiles = listLegacyUnscopedFiles();
  const legacyTtlDays = legacyQuarantineTtlDays();
  const legacy = evaluateLegacyQuarantine(legacyFiles, Date.now(), legacyTtlDays);
  const legacyCount = legacy.count;
  const priorLegacyCount = readPriorLegacyCount();
  const legacyGrowth = priorLegacyCount === undefined ? 0 : legacyCount - priorLegacyCount;
  const alerts: KnowledgeScopeHealthReport['alerts'] = [];
  for (const row of rows) {
    if (!row.knowledge_root_exists) {
      alerts.push({
        code: 'missing_knowledge_root',
        tenant_slug: row.tenant_slug,
        message: row.reason || 'registered tenant knowledge root does not exist',
      });
    } else if (row.allowlisted_roots.length === 0) {
      alerts.push({
        code: 'empty_allowlist',
        tenant_slug: row.tenant_slug,
        message: row.reason || 'tenant has no positive retrieval allowlist',
      });
    }
  }
  if (legacyGrowth > 0) {
    alerts.push({
      code: 'legacy_growth',
      message: `unscoped feedback files increased by ${legacyGrowth} (${legacyCount} total)`,
    });
  }
  if (legacy.ttl_breached) {
    alerts.push({
      code: 'legacy_ttl_breach',
      message: `oldest unscoped feedback file is ${legacy.oldest_age_days} day(s) old; quarantine TTL is ${legacyTtlDays} day(s)`,
    });
  }
  if (options.persistHistory) persistLegacyCount(legacyCount, generatedAt);
  return {
    generated_at: generatedAt,
    status:
      rows.some((row) => row.status === 'attention') || alerts.length > 0 ? 'attention' : 'healthy',
    summary: {
      registered_tenants: rows.length,
      healthy: rows.filter((row) => row.status === 'healthy').length,
      attention: rows.filter((row) => row.status === 'attention').length,
      legacy_unscoped_file_count: legacyCount,
      legacy_unscoped_growth: legacyGrowth,
      legacy_unscoped_oldest_age_days: legacy.oldest_age_days,
      legacy_quarantine_ttl_days: legacyTtlDays,
    },
    alerts,
    tenants: rows,
  };
}

function buildHealthAlert(report: KnowledgeScopeHealthReport): OpsAlertInput {
  return {
    severity: report.alerts.some((alert) => alert.code === 'missing_knowledge_root')
      ? 'critical'
      : 'warning',
    category: 'knowledge-scope',
    title: 'Tenant knowledge scope health requires attention',
    context: {
      alert_codes: report.alerts.map((alert) => alert.code),
      alerts: report.alerts,
      summary: report.summary,
      generated_at: report.generated_at,
    },
    recommendation:
      'Repair the registered tenant knowledge root or allowlist, then run the scope health watchdog again. Quarantine legacy feedback rather than copying it into a tenant scope without provenance.',
    options: [
      'pnpm knowledge:scope-health -- --json',
      'pnpm knowledge:scope-health -- --json --alert',
      'Review active/shared/runtime/feedback-loop and the tenant registry before migration.',
    ],
    dedupe_key: 'knowledge-scope-health',
  };
}

const isDirect =
  process.argv[1] != null && /watch_knowledge_scope_health\.(ts|js)$/u.test(process.argv[1]);
if (isDirect) {
  const report = scanKnowledgeScopeHealth({ persistHistory: process.argv.includes('--alert') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else
    console.log(
      `${report.status}: ${report.summary.healthy}/${report.summary.registered_tenants} tenant knowledge roots healthy; legacy=${report.summary.legacy_unscoped_file_count} (growth=${report.summary.legacy_unscoped_growth})`
    );
  if (process.argv.includes('--alert') && report.alerts.length > 0) {
    const receipt = sendOpsAlert(buildHealthAlert(report));
    if (!process.argv.includes('--quiet')) {
      console.warn(
        `[knowledge-scope-health] ops alert recorded at ${receipt.recorded_path}; webhook=${receipt.webhook_delivered ? 'delivered' : 'not-delivered'}`
      );
    }
  }
  if (process.argv.includes('--fail') && report.status !== 'healthy') process.exitCode = 1;
}

export { buildHealthAlert };
