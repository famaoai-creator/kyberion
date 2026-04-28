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
import {
  safeReadFile,
  safeReaddir,
  safeExistsSync,
  safeLstat,
  pathResolver,
} from '@agent/core';

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

export function getTenantScope(): string | undefined {
  const slug = (process.env.KYBERION_TENANT || '').trim();
  if (!slug) return undefined;
  return TENANT_SLUG_RE.test(slug) ? slug : undefined;
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

function readJsonSafe<T>(absPath: string): T | null {
  try {
    if (!safeExistsSync(absPath)) return null;
    return JSON.parse(safeReadFile(absPath, { encoding: 'utf8' }) as string) as T;
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

function detectMissionTenantSlug(state: any, dirPath: string): string | undefined {
  if (state?.tenant_slug) return state.tenant_slug;
  // Path-based detection: confidential/{slug}/MSN-... layout.
  const segs = dirPath.split(path.sep);
  const idx = segs.indexOf('confidential');
  if (idx >= 0 && segs[idx + 1] && TENANT_SLUG_RE.test(segs[idx + 1])) {
    return segs[idx + 1];
  }
  return undefined;
}

function listMissionsForTier(tier: 'personal' | 'confidential' | 'public'): MissionRow[] {
  const tierRoot = pathResolver.rootResolve(`active/missions/${tier}`);
  if (!safeExistsSync(tierRoot)) return [];
  const rows: MissionRow[] = [];
  const visit = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = safeReaddir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry);
      let stat;
      try {
        stat = safeLstat(abs);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const statePath = path.join(abs, 'mission-state.json');
      if (safeExistsSync(statePath)) {
        const state = readJsonSafe<any>(statePath);
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
  const all = [
    ...listMissionsForTier('public'),
    ...listMissionsForTier('confidential'),
  ];
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
    const tierRoot = pathResolver.rootResolve(`active/missions/${tier}`);
    if (!safeExistsSync(tierRoot)) continue;
    const stack: string[] = [tierRoot];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = safeReaddir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry !== upperId && entry !== 'mission-state.json') {
          const sub = path.join(dir, entry);
          let stat;
          try {
            stat = safeLstat(sub);
          } catch {
            continue;
          }
          if (stat.isDirectory()) stack.push(sub);
          continue;
        }
        const candidate = path.join(dir, upperId);
        const statePath = path.join(candidate, 'mission-state.json');
        if (!safeExistsSync(statePath)) continue;
        const state = readJsonSafe<any>(statePath);
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

function listEvidenceFiles(missionDir: string): Array<{ name: string; bytes: number; modified_at: string }> {
  const evidenceDir = path.join(missionDir, 'evidence');
  if (!safeExistsSync(evidenceDir)) return [];
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

export function listRecentAuditEvents(limit = 100): AuditEventRow[] {
  const scope = getTenantScope();
  const auditDir = pathResolver.rootResolve('active/audit');
  if (!safeExistsSync(auditDir)) return [];
  const rows: AuditEventRow[] = [];
  let entries: string[] = [];
  try {
    entries = safeReaddir(auditDir);
  } catch {
    return [];
  }
  const ledgers = entries.filter((f) => f.endsWith('.jsonl')).sort();
  for (const ledger of ledgers) {
    const txt = safeReadFile(path.join(auditDir, ledger), { encoding: 'utf8' }) as string;
    for (const line of txt.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const tenantSlug = event.tenantSlug || event.tenant_slug;
      if (scope && tenantSlug && tenantSlug !== scope) continue;
      // Tenantless events are visible to everyone (cross-tenant tooling).
      rows.push({
        id: event.id,
        timestamp: event.timestamp,
        agentId: event.agentId || event.agent_id || '',
        action: event.action,
        operation: event.operation || '',
        result: event.result || '',
        reason: event.reason,
        tenantSlug,
        mission_id: event.mission_id || event.metadata?.mission_id,
      });
    }
  }
  return rows.slice(-limit).reverse();
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
    recent_override_events: events.filter(
      (e) => e.action === 'rubric.override_accepted',
    ).length,
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
