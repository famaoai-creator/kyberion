/**
 * MOS Read-Only Data Layer
 *
 * The MOS is observation-only. This module imports only the read APIs
 * from secure-io. Any future contributor adding any mutating API import
 * will trip the contract test in test/no-write-api.test.ts.
 *
 * Tenant scoping: every loader respects KYBERION_TENANT (when set) and
 * filters cross-tenant data out. There is no UI control to switch
 * tenants — the operator's KYBERION_TENANT env binds the session.
 */

import * as path from 'node:path';
import { parseSafeJsonInput, parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeReaddir,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { loadStateAtPath } from '@agent/core/mission-state';
import {
  loadCapabilityBundleRegistry,
  type CapabilityBundleEntry,
} from '@agent/core/capability-bundle-registry';
import { scanProviderCapabilities } from '@agent/core/provider-capability-scanner';
import { CloudflareOsControlPlane } from '@agent/core/cloudflare-os-control-plane';
import {
  CloudflareOsSurface,
  CloudflareOsReadOnlySurface,
  type CloudflareOsSurfaceAccess,
  type CloudflareOsSurfaceSnapshot,
} from '@agent/core/cloudflare-os-surface';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  buildSurfaceLauncherRecommendations,
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
  type SurfaceDirectoryRow,
  type SurfaceDirectorySummary,
  type SurfaceScenarioGuide,
  type SurfaceLauncherRecommendation,
} from '@agent/core/surface-ux';
import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';

export {
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
  buildSurfaceLauncherRecommendations,
};
export type {
  SurfaceDirectoryRow,
  SurfaceDirectorySummary,
  SurfaceScenarioGuide,
  SurfaceLauncherRecommendation,
  CloudflareOsSurfaceAccess,
  CloudflareOsSurfaceSnapshot,
};
export { listIntentSnapshotRows } from './intent-snapshots';
export type { IntentSnapshotRow } from './intent-snapshots';

export function getTenantScope(): string | undefined {
  const slug = (getRegisteredEnvText('KYBERION_TENANT') || '').trim();
  if (!slug) return undefined;
  return isValidTenantSlug(slug) ? slug : undefined;
}

/**
 * Build the MOS OS projection scope without accepting tenant input from the
 * browser. An explicitly configured tenant sees its own confidential data;
 * an unscoped MOS is limited to public observations and cannot see held
 * actions belonging to an unknown tenant.
 */
export function getOsSurfaceAccess(): CloudflareOsSurfaceAccess {
  const tenant = getTenantScope();
  const configuredPrincipal = (getRegisteredEnvText('KYBERION_MOS_PRINCIPAL') || '').trim();
  if (tenant && !configuredPrincipal) {
    throw new Error(
      '[POLICY_VIOLATION] KYBERION_MOS_PRINCIPAL is required for tenant-scoped OS projection'
    );
  }
  if (configuredPrincipal && !configuredPrincipal.startsWith('human:')) {
    throw new Error('[POLICY_VIOLATION] KYBERION_MOS_PRINCIPAL must identify a human viewer');
  }
  return {
    principalId: configuredPrincipal || 'human:operator-surface-local',
    tenantSlugs: tenant ? [tenant] : [],
  };
}

export function getCloudflareOsSnapshot(missionId?: string): CloudflareOsSurfaceSnapshot {
  return new CloudflareOsReadOnlySurface(
    new CloudflareOsSurface(new CloudflareOsControlPlane({ auditRestoreFailures: false }))
  ).snapshot(missionId, getOsSurfaceAccess());
}

export function getGuardedSurfaceUrl(): string | undefined {
  const configured = (getRegisteredEnvText('KYBERION_OS_GUARDED_SURFACE_URL') || '').trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface MissionRow {
  mission_id: string;
  status: string;
  tier: 'personal' | 'confidential' | 'public';
  tenant_slug?: string;
  assigned_persona?: string;
  latest_commit?: string;
  history_count?: number;
  checkpoints_count?: number;
}

export interface MissionDetail extends MissionRow {
  mission_type?: string;
  history?: Array<{ ts: string; event: string; note?: string }>;
  checkpoints?: Array<{ task_id: string; commit_hash: string; ts: string }>;
  evidence_files?: Array<{ name: string; bytes: number; modified_at: string }>;
}

function readMissionState(absPath: string) {
  try {
    const safePath = assertSafeRepositoryPath(absPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return loadStateAtPath(safePath);
  } catch {
    return null;
  }
}

function safeResourcePath(absPath: string): string | null {
  try {
    return assertSafeRepositoryPath(absPath, { allowMissingLeaf: true });
  } catch {
    return null;
  }
}

function eligibleTier(tier: string, scope: string | undefined): boolean {
  if (!scope) return true;
  // Tenant-scoped operators see only their own confidential paths and
  // public tier. Personal tier is per-user, not visible to MOS.
  return tier === 'public' || tier === 'confidential';
}

function detectMissionTenantSlug(
  state: { tenant_slug?: string },
  dirPath: string
): string | undefined {
  if (state?.tenant_slug) return state.tenant_slug;
  // Path-based detection: confidential/{slug}/MSN-... layout.
  const segs = dirPath.split(path.sep);
  const idx = segs.indexOf('confidential');
  if (idx >= 0 && segs[idx + 1] && isValidTenantSlug(segs[idx + 1])) {
    return segs[idx + 1];
  }
  return undefined;
}

function listMissionsForTier(tier: 'personal' | 'confidential' | 'public'): MissionRow[] {
  const tierRoot = safeResourcePath(pathResolver.rootResolve(`active/missions/${tier}`));
  if (!tierRoot || !safeExistsSync(tierRoot) || !safeLstat(tierRoot).isDirectory()) return [];
  const rows: MissionRow[] = [];
  const visit = (dir: string) => {
    const safeDir = safeResourcePath(dir);
    if (!safeDir || !safeExistsSync(safeDir) || !safeLstat(safeDir).isDirectory()) return;
    let entries: string[] = [];
    try {
      entries = safeReaddir(safeDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = safeResourcePath(path.join(safeDir, entry));
      if (!abs) continue;
      let stat;
      try {
        stat = safeLstat(abs);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const statePath = safeResourcePath(path.join(abs, 'mission-state.json'));
      if (statePath && safeExistsSync(statePath) && safeLstat(statePath).isFile()) {
        const state = readMissionState(statePath);
        if (!state) continue;
        rows.push({
          mission_id: state.mission_id,
          status: state.status,
          tier,
          tenant_slug: detectMissionTenantSlug(state, abs),
          assigned_persona: state.assigned_persona,
          latest_commit: state.git?.latest_commit?.slice(0, 8),
          history_count: state.history?.length ?? 0,
          checkpoints_count: state.git?.checkpoints?.length ?? 0,
        });
      } else {
        // Recurse one level (tenant-prefixed missions are nested deeper).
        visit(abs);
      }
    }
  };
  visit(tierRoot);
  return rows;
}

export function listMissions(): MissionRow[] {
  const scope = getTenantScope();
  const all = [...listMissionsForTier('public'), ...listMissionsForTier('confidential')];
  return all
    .filter((m) => eligibleTier(m.tier, scope))
    .filter((m) => {
      if (!scope) return true;
      // Tenant-scoped: only show missions belonging to this tenant or
      // tenant-agnostic public tooling missions.
      if (m.tier === 'public') return true;
      return m.tenant_slug === scope;
    })
    .sort((a, b) => a.mission_id.localeCompare(b.mission_id));
}

export function getMissionDetail(missionId: string): MissionDetail | null {
  const upperId = missionId.toUpperCase();
  const scope = getTenantScope();
  const tiers: Array<'personal' | 'confidential' | 'public'> = ['public', 'confidential'];
  for (const tier of tiers) {
    const tierRoot = safeResourcePath(pathResolver.rootResolve(`active/missions/${tier}`));
    if (!tierRoot || !safeExistsSync(tierRoot) || !safeLstat(tierRoot).isDirectory()) continue;
    const stack: string[] = [tierRoot];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      let safeDir: string | null = null;
      try {
        safeDir = safeResourcePath(dir);
        if (!safeDir || !safeExistsSync(safeDir) || !safeLstat(safeDir).isDirectory()) continue;
        entries = safeReaddir(safeDir);
      } catch {
        continue;
      }
      if (!safeDir) continue;
      for (const entry of entries) {
        if (entry !== upperId && entry !== 'mission-state.json') {
          const sub = safeResourcePath(path.join(safeDir, entry));
          if (!sub) continue;
          let stat;
          try {
            stat = safeLstat(sub);
          } catch {
            continue;
          }
          if (stat.isDirectory()) stack.push(sub);
          continue;
        }
        const candidate = safeResourcePath(path.join(safeDir, upperId));
        const statePath = candidate
          ? safeResourcePath(path.join(candidate, 'mission-state.json'))
          : null;
        if (
          !candidate ||
          !statePath ||
          !safeExistsSync(statePath) ||
          !safeLstat(statePath).isFile()
        )
          continue;
        const state = readMissionState(statePath);
        if (!state) continue;
        const tenantSlug = detectMissionTenantSlug(state, candidate);
        if (scope && state.tier !== 'public' && tenantSlug !== scope) continue;
        const detail: MissionDetail = {
          mission_id: state.mission_id,
          status: state.status,
          tier: state.tier,
          mission_type: state.mission_type,
          ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
          assigned_persona: state.assigned_persona,
          latest_commit: state.git?.latest_commit,
          history_count: state.history?.length ?? 0,
          checkpoints_count: state.git?.checkpoints?.length ?? 0,
          history: state.history,
          checkpoints: state.git?.checkpoints,
          evidence_files: listEvidenceFiles(candidate),
        };
        return detail;
      }
    }
  }
  return null;
}

function listEvidenceFiles(
  missionDir: string
): Array<{ name: string; bytes: number; modified_at: string }> {
  let evidenceDir: string;
  try {
    evidenceDir = assertSafeRepositoryPath(path.join(missionDir, 'evidence'), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(evidenceDir) || !safeLstat(evidenceDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: Array<{ name: string; bytes: number; modified_at: string }> = [];
  try {
    for (const entry of safeReaddir(evidenceDir)) {
      const abs = path.join(evidenceDir, entry);
      let stat;
      try {
        stat = safeLstat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({
        name: entry,
        bytes: stat.size,
        modified_at: new Date(stat.mtimeMs).toISOString(),
      });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

export interface AuditEventRow {
  id: string;
  timestamp: string;
  agentId: string;
  action: string;
  operation: string;
  result: string;
  reason?: string;
  tenantSlug?: string;
  mission_id?: string;
}

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function auditStringField(
  event: Record<string, unknown>,
  primaryKey: string,
  legacyKey?: string
): string | undefined {
  const primary = event[primaryKey];
  const legacy = legacyKey ? event[legacyKey] : undefined;
  if (primary !== undefined && typeof primary !== 'string') return undefined;
  if (legacy !== undefined && typeof legacy !== 'string') return undefined;
  if (primary !== undefined && legacy !== undefined && primary !== legacy) return undefined;
  const value = primary ?? legacy;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseAuditEvent(raw: string): AuditEventRow | null {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw, 'operator-surface audit event');
  } catch {
    return null;
  }
  if (!isAuditRecord(parsed)) return null;

  const id = auditStringField(parsed, 'id');
  const timestamp = auditStringField(parsed, 'timestamp');
  const agentId = auditStringField(parsed, 'agentId', 'agent_id');
  const action = auditStringField(parsed, 'action');
  const operation = auditStringField(parsed, 'operation');
  const result = auditStringField(parsed, 'result');
  const reason = auditStringField(parsed, 'reason');
  const tenantSlug = auditStringField(parsed, 'tenantSlug', 'tenant_slug');
  const missionId = auditStringField(parsed, 'mission_id');
  const metadata = parsed.metadata;
  const metadataMissionId = isAuditRecord(metadata)
    ? auditStringField(metadata, 'mission_id')
    : undefined;

  if (!id || !timestamp || !action || (parsed.metadata !== undefined && !isAuditRecord(metadata))) {
    return null;
  }
  return {
    id,
    timestamp,
    agentId: agentId || '',
    action,
    operation: operation || '',
    result: result || '',
    reason,
    tenantSlug,
    mission_id: missionId || metadataMissionId,
  };
}

export function listRecentAuditEvents(limit = 100): AuditEventRow[] {
  const scope = getTenantScope();
  const auditDir = safeResourcePath(pathResolver.rootResolve('active/audit'));
  if (!auditDir || !safeExistsSync(auditDir) || !safeLstat(auditDir).isDirectory()) return [];
  const rows: AuditEventRow[] = [];
  let entries: string[] = [];
  try {
    entries = safeReaddir(auditDir);
  } catch {
    return [];
  }
  const ledgers = entries.filter((f) => f.endsWith('.jsonl')).sort();
  for (const ledger of ledgers) {
    const ledgerPath = safeResourcePath(path.join(auditDir, ledger));
    if (!ledgerPath || !safeExistsSync(ledgerPath) || !safeLstat(ledgerPath).isFile()) continue;
    const txt = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
    for (const line of txt.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseAuditEvent(trimmed);
      if (!event) continue;
      // A tenant-scoped viewer must never receive an event without an explicit
      // tenant; an unscoped viewer is limited to tenantless public observations.
      if (scope ? !event.tenantSlug || event.tenantSlug !== scope : event.tenantSlug) continue;
      rows.push(event);
    }
  }
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
  return rows.slice(-boundedLimit).reverse();
}

export interface HealthSummary {
  active_missions: number;
  completed_missions: number;
  failed_missions: number;
  recent_audit_events_24h: number;
  recent_override_events: number;
  scope?: string;
}

export function getHealthSummary(): HealthSummary {
  const missions = listMissions();
  const events = listRecentAuditEvents(1000);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = events.filter((e) => {
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    return t >= cutoff;
  });
  return {
    active_missions: missions.filter((m) => m.status === 'active').length,
    completed_missions: missions.filter((m) => m.status === 'completed').length,
    failed_missions: missions.filter((m) => m.status === 'failed').length,
    recent_audit_events_24h: recent.length,
    recent_override_events: events.filter((e) => e.action === 'rubric.override_accepted').length,
    ...(getTenantScope() ? { scope: getTenantScope() } : {}),
  };
}

/**
 * Format a `suggested_command` for the operator to copy. We never run
 * commands server-side. Surfaces use this to render "press Cmd-C" hints.
 */
export function suggestedCommand(opts: {
  intent: 'verify' | 'distill' | 'finish' | 'export-bundle' | 'view-evidence';
  missionId: string;
}): string {
  switch (opts.intent) {
    case 'verify':
      return `node dist/scripts/mission_controller.js verify ${opts.missionId} verified "<note>"`;
    case 'distill':
      return `node dist/scripts/mission_controller.js distill ${opts.missionId}`;
    case 'finish':
      return `node dist/scripts/mission_controller.js finish ${opts.missionId}`;
    case 'export-bundle':
      return `pnpm export:validation-bundle ${opts.missionId}`;
    case 'view-evidence':
      return `ls active/missions/*/${opts.missionId}/evidence/`;
  }
}

export function getCapabilities() {
  const registry = loadCapabilityBundleRegistry();
  const scanned = scanProviderCapabilities(undefined, undefined, { includeUnavailable: true });

  return registry.bundles.map((bundle: CapabilityBundleEntry) => {
    const refs = bundle.harness_capability_refs || [];
    const requiredCaps = scanned.filter((c) => refs.includes(c.capability_id));
    const missingCount = requiredCaps.filter((c) => c.discovery_status === 'missing').length;
    const totalCount = requiredCaps.length;

    let health: 'active' | 'degraded' | 'inactive' = 'active';
    if (totalCount > 0) {
      if (missingCount === totalCount) {
        health = 'inactive';
      } else if (missingCount > 0) {
        health = 'degraded';
      }
    }

    return {
      bundle_id: bundle.bundle_id,
      status: bundle.status,
      kind: bundle.kind,
      summary: bundle.summary,
      health,
      intents: bundle.intents || [],
      required_actuators: bundle.required_actuators || [],
      dependencies: requiredCaps.map((c) => ({
        id: c.capability_id,
        status: c.discovery_status as 'available' | 'missing',
        provider: c.source.provider,
      })),
    };
  });
}

export function getProviderPins(): Record<string, any> {
  const pins: Record<string, any> = {};

  const readPins = (filePath: string): Record<string, unknown> => {
    const data = parseSafeJsonObjectValue(readJson<unknown>(filePath), `provider pins ${filePath}`);
    return data.pins === undefined
      ? {}
      : parseSafeJsonObjectValue(data.pins, `provider pins ${filePath}.pins`);
  };

  // 1. Read default pins
  const defaultPath = pathResolver.rootResolve('active/shared/runtime/provider-pins/default.json');
  let safeDefaultPath: string | null = null;
  try {
    const candidate = assertSafeRepositoryPath(defaultPath, { allowMissingLeaf: true });
    if (safeExistsSync(candidate) && safeLstat(candidate).isFile()) safeDefaultPath = candidate;
  } catch {
    safeDefaultPath = null;
  }
  if (safeDefaultPath) {
    try {
      Object.assign(pins, readPins(safeDefaultPath));
    } catch (err) {
      logger.warn(`[data] suppressed error in getProviderPins: ${err}`);
    }
  }

  // 2. Scan all session pin files in active/shared/runtime/provider-pins/
  const dirPath = pathResolver.rootResolve('active/shared/runtime/provider-pins');
  let safeDirPath: string | null = null;
  try {
    const candidate = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
    if (safeExistsSync(candidate) && safeLstat(candidate).isDirectory()) safeDirPath = candidate;
  } catch {
    safeDirPath = null;
  }
  if (safeDirPath) {
    try {
      const files = safeReaddir(safeDirPath);
      for (const file of files) {
        if (file === 'default.json' || !file.endsWith('.json')) continue;
        const fullPath = assertSafeRepositoryPath(path.join(safeDirPath, file), {
          allowMissingLeaf: true,
        });
        if (!safeExistsSync(fullPath) || !safeLstat(fullPath).isFile()) continue;
        Object.assign(pins, readPins(fullPath));
      }
    } catch (err) {
      logger.warn(`[data] suppressed error in getProviderPins: ${err}`);
    }
  }

  return pins;
}
