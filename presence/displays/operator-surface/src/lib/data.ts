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
  loadCapabilityBundleRegistry,
  scanProviderCapabilities,
  type CapabilityBundleEntry,
} from '@agent/core';
import { secretGuard } from '@agent/core';
import { loadSurfaceManifest, loadSurfaceState } from '@agent/core/surface-runtime';
import { getServicePresetPolicy } from '@agent/core/service-preset-policy';

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

export function getCapabilities() {
  const registry = loadCapabilityBundleRegistry();
  const scanned = scanProviderCapabilities(undefined, undefined, { includeUnavailable: true });

  return registry.bundles.map((bundle: CapabilityBundleEntry) => {
    const refs = bundle.harness_capability_refs || [];
    const requiredCaps = scanned.filter(c => refs.includes(c.capability_id));
    const missingCount = requiredCaps.filter(c => c.discovery_status === 'missing').length;
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
      dependencies: requiredCaps.map(c => ({
        id: c.capability_id,
        status: c.discovery_status as 'available' | 'missing',
        provider: c.source.provider
      }))
    };
  });
}

export function getProviderPins(): Record<string, any> {
  const pins: Record<string, any> = {};

  // 1. Read default pins
  const defaultPath = pathResolver.rootResolve('active/shared/runtime/provider-pins/default.json');
  if (safeExistsSync(defaultPath)) {
    try {
      const data = JSON.parse(safeReadFile(defaultPath, { encoding: 'utf8' }) as string);
      Object.assign(pins, data.pins || {});
    } catch (_) {}
  }

  // 2. Scan all session pin files in active/shared/runtime/provider-pins/
  const dirPath = pathResolver.rootResolve('active/shared/runtime/provider-pins');
  if (safeExistsSync(dirPath)) {
    try {
      const files = safeReaddir(dirPath);
      for (const file of files) {
        if (file === 'default.json' || !file.endsWith('.json')) continue;
        const fullPath = path.join(dirPath, file);
        const data = JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string);
        Object.assign(pins, data.pins || {});
      }
    } catch (_) {}
  }

  return pins;
}

export interface SurfaceDirectoryRow {
  id: string;
  kind: string;
  description: string;
  enabled: boolean;
  runtime_status: 'running' | 'stale' | 'stopped';
  startup_mode: string;
  authority_role: string;
  auth_requirement: 'required' | 'session_or_oauth' | 'host-managed';
  auth_strategy: string;
  auth_status: 'ready' | 'missing' | 'n/a';
  required_secrets: string[];
  use_cases: string[];
  operator_notes: string;
  next_command: string;
}

export interface SurfaceScenarioGuide {
  id: string;
  title: string;
  summary: string;
  surface_ids: string[];
  guidance: string;
}

export interface SurfaceDirectorySummary {
  total: number;
  enabled: number;
  auth_required: number;
  auth_missing: number;
  running: number;
  stale: number;
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function surfaceScenarioIds(surfaceId: string): string[] {
  const ids = new Set<string>();
  if (['presence-studio', 'voice-hub'].includes(surfaceId)) {
    ids.add('voice-first-win');
  }
  if (['slack-bridge', 'imessage-bridge', 'telegram-bridge', 'discord-bridge'].includes(surfaceId)) {
    ids.add('messaging-ingress');
  }
  if (['chronos-mirror-v2', 'terminal-bridge', 'computer-surface'].includes(surfaceId)) {
    ids.add('operator-control');
  }
  if (surfaceId === 'oauth-callback-surface') {
    ids.add('oauth-bootstrap');
  }
  if (surfaceId === 'mcp-server-cowork') {
    ids.add('desktop-cowork');
  }
  if (['chronos-mirror-v2', 'slack-bridge', 'oauth-callback-surface'].includes(surfaceId)) {
    ids.add('customer-engagement');
  }
  return [...ids];
}

function surfaceOperatorNotes(surfaceId: string): string {
  switch (surfaceId) {
    case 'slack-bridge':
      return 'External channel ingress. Auth readiness matters before runtime repair.';
    case 'oauth-callback-surface':
      return 'Loopback-only helper for completing OAuth handshakes into personal connections.';
    case 'chronos-mirror-v2':
      return 'Primary operator control UI for mission and runtime visibility.';
    case 'presence-studio':
      return 'Best suited for expressive voice / transcript feedback during first-win demos.';
    case 'voice-hub':
      return 'Pairs with Presence Studio. Browser and OS permissions usually fail before the runtime itself.';
    case 'computer-surface':
      return 'Use for governed browser or terminal walkthroughs after runtime is already healthy.';
    case 'terminal-bridge':
      return 'Background bridge. Operators usually feel breakage here indirectly through control surfaces.';
    case 'mcp-server-cowork':
      return 'Desktop integration surface. Good fit when the operator already lives in an MCP client.';
    default:
      return 'Managed runtime surface exposed through the surface manifest catalog.';
  }
}

function surfaceNextCommand(row: {
  auth_requirement: SurfaceDirectoryRow['auth_requirement'];
  auth_status: SurfaceDirectoryRow['auth_status'];
  runtime_status: SurfaceDirectoryRow['runtime_status'];
  id: string;
}): string {
  if (row.auth_requirement !== 'host-managed' && row.auth_status === 'missing') {
    return 'pnpm surfaces:setup';
  }
  if (row.runtime_status === 'stale') {
    return `pnpm surfaces:repair -- --surface ${row.id}`;
  }
  if (row.runtime_status === 'stopped') {
    return `pnpm surfaces:start --surface ${row.id}`;
  }
  return `pnpm surfaces:status -- --surface ${row.id}`;
}

function loadAuthorityRoleIndex(): Record<string, any> {
  const payload = readJsonSafe<{ authority_roles?: Record<string, any> }>(
    pathResolver.rootResolve('knowledge/product/governance/authority-role-index.json'),
  );
  return payload?.authority_roles || {};
}

function loadServiceEndpointCatalog(): Record<string, any> {
  const payload = readJsonSafe<{ services?: Record<string, any> }>(
    pathResolver.rootResolve('knowledge/product/orchestration/service-endpoints.json'),
  );
  return payload?.services || {};
}

function inspectSurfaceAuthReadOnly(definition: Record<string, any>): Pick<
  SurfaceDirectoryRow,
  'auth_requirement' | 'auth_strategy' | 'auth_status' | 'required_secrets'
> {
  const presetPath = typeof definition.preset_path === 'string' ? definition.preset_path : '';
  if (!presetPath) {
    return {
      auth_requirement: 'host-managed',
      auth_strategy: 'host-managed',
      auth_status: 'n/a',
      required_secrets: [],
    };
  }

  const resolvedPresetPath = pathResolver.rootResolve(presetPath);
  const preset = readJsonSafe<Record<string, any>>(resolvedPresetPath);
  const policy = getServicePresetPolicy(preset);
  const strategy = (policy.auth_strategy || 'none').toLowerCase();
  const serviceId = typeof definition.service_id === 'string' ? definition.service_id : String(definition.id || '');
  const endpoint = loadServiceEndpointCatalog()[serviceId];
  const suffixes = endpoint?.credential_suffixes || {};
  const requiredSecrets = Array.from(new Set(
    strategy === 'bearer'
      ? [...(suffixes.accessToken || ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN'])]
      : strategy === 'basic'
        ? [
            ...(suffixes.clientId || ['CLIENT_ID']),
            ...(suffixes.clientSecret || ['CLIENT_SECRET']),
            ...(suffixes.accessToken || ['ACCESS_TOKEN']),
          ]
        : strategy === 'session'
          ? [
              ...(suffixes.clientId || ['CLIENT_ID']),
              ...(suffixes.clientSecret || ['CLIENT_SECRET']),
              ...(suffixes.redirectUri || ['REDIRECT_URI']),
            ]
          : []
  )).map((suffix) => `${serviceId.toUpperCase()}_${suffix}`);
  const hasAnySecret = requiredSecrets.some((envName) => Boolean(secretGuard.getSecret(envName)));

  if (strategy === 'session') {
    return {
      auth_requirement: 'session_or_oauth',
      auth_strategy: strategy,
      auth_status: hasAnySecret ? 'ready' : 'missing',
      required_secrets: requiredSecrets,
    };
  }

  if (strategy === 'none') {
    return {
      auth_requirement: 'host-managed',
      auth_strategy: strategy,
      auth_status: 'n/a',
      required_secrets: [],
    };
  }

  return {
    auth_requirement: 'required',
    auth_strategy: strategy,
    auth_status: hasAnySecret ? 'ready' : 'missing',
    required_secrets: requiredSecrets,
  };
}

export function getSurfaceDirectory(): SurfaceDirectoryRow[] {
  const manifest = loadSurfaceManifest();
  const state = loadSurfaceState();
  const roles = loadAuthorityRoleIndex();

  return manifest.surfaces
    .map((definition) => {
      const record = state.surfaces[definition.id];
      const runtimeStatus: SurfaceDirectoryRow['runtime_status'] = record
        ? isProcessRunning(record.pid) ? 'running' : 'stale'
        : 'stopped';
      const auth = inspectSurfaceAuthReadOnly(definition as Record<string, any>);
      const authorityRole = String((definition as any).env?.MISSION_ROLE || 'surface_runtime');
      const authority = roles[authorityRole];
      const notes = authority?.description
        ? `${surfaceOperatorNotes(definition.id)} ${authority.description}`
        : surfaceOperatorNotes(definition.id);
      const row: SurfaceDirectoryRow = {
        id: definition.id,
        kind: definition.kind,
        description: definition.description,
        enabled: definition.enabled !== false,
        runtime_status: runtimeStatus,
        startup_mode: definition.startupMode || 'background',
        authority_role: authorityRole,
        auth_requirement: auth.auth_requirement,
        auth_strategy: auth.auth_strategy,
        auth_status: auth.auth_status,
        required_secrets: auth.required_secrets,
        use_cases: surfaceScenarioIds(definition.id),
        operator_notes: notes,
        next_command: '',
      };
      row.next_command = surfaceNextCommand(row);
      return row;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getSurfaceScenarioGuide(): SurfaceScenarioGuide[] {
  return [
    {
      id: 'voice-first-win',
      title: 'Voice first win',
      summary: 'Use when demonstrating the first conversational loop with transcript and audio feedback.',
      surface_ids: ['presence-studio', 'voice-hub'],
      guidance: 'Check browser and OS permissions before debugging runtime health. If the loop fails, treat permissions as the first suspect.',
    },
    {
      id: 'messaging-ingress',
      title: 'Messaging ingress',
      summary: 'Use when the operator wants natural-language requests to arrive through Slack or another message channel.',
      surface_ids: ['slack-bridge', 'imessage-bridge', 'telegram-bridge', 'discord-bridge'],
      guidance: 'Auth readiness comes before runtime repair. Start with pnpm surfaces:setup, then reconcile the specific bridge.',
    },
    {
      id: 'operator-control',
      title: 'Operator control',
      summary: 'Use for mission visibility, browser walkthroughs, and governed runtime supervision.',
      surface_ids: ['chronos-mirror-v2', 'terminal-bridge', 'computer-surface'],
      guidance: 'This is the default control path for browser-heavy or long-running work. Repair stale background bridges before blaming the UI.',
    },
    {
      id: 'oauth-bootstrap',
      title: 'OAuth bootstrap',
      summary: 'Use when a service integration needs an interactive callback to finish session-based auth.',
      surface_ids: ['oauth-callback-surface'],
      guidance: 'Keep this loopback helper available during onboarding and service setup. It is not the day-to-day operator UI.',
    },
    {
      id: 'customer-engagement',
      title: 'Customer engagement handoff',
      summary: 'Use when switching overlays and validating which surfaces are fit for the active customer engagement.',
      surface_ids: ['chronos-mirror-v2', 'slack-bridge', 'oauth-callback-surface'],
      guidance: 'After customer switch and doctor/onboard, confirm the operator UI, the target channel, and any auth helper needed for that engagement.',
    },
    {
      id: 'desktop-cowork',
      title: 'Desktop cowork',
      summary: 'Use when Kyberion should surface capabilities through an MCP-connected desktop client.',
      surface_ids: ['mcp-server-cowork'],
      guidance: 'Prefer this when the operator already works inside an MCP host and does not need a separate web surface.',
    },
  ];
}

export function getSurfaceDirectorySummary(): SurfaceDirectorySummary {
  const rows = getSurfaceDirectory();
  return rows.reduce<SurfaceDirectorySummary>((acc, row) => {
    acc.total += 1;
    if (row.enabled) acc.enabled += 1;
    if (row.auth_requirement !== 'host-managed') acc.auth_required += 1;
    if (row.auth_status === 'missing') acc.auth_missing += 1;
    if (row.runtime_status === 'running') acc.running += 1;
    if (row.runtime_status === 'stale') acc.stale += 1;
    return acc;
  }, {
    total: 0,
    enabled: 0,
    auth_required: 0,
    auth_missing: 0,
    running: 0,
    stale: 0,
  });
}
