import * as path from 'node:path';
import { MetricsCollector } from './metrics.js';
import { listApprovalRequests } from './approval-store.js';
import { listArtifactRecords } from './artifact-record.js';
import { buildNextAction, type NextAction } from './next-action.js';
import { listInboxEntries, type DeliverableInboxEntry } from './deliverable-inbox.js';
import { pathResolver } from './path-resolver.js';
import { loadJson, safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';
import { loadMissionStaffingAssignments } from './mission-team-binding.js';
import { buildNhiLedgerReport } from './nhi-lifecycle-governance.js';

export interface OperatorHomeMissionItem {
  missionId: string;
  status: string;
  tier: 'personal' | 'confidential' | 'public';
  missionType?: string;
  tenantSlug?: string;
  tenantId?: string;
  organizationId?: string;
  persona?: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
  updatedAt?: string;
  goalSummary?: string;
  successCondition?: string;
  artifactKinds: string[];
  artifactCount: number;
}

export interface OperatorHomeCostSummary {
  totalTokens: number;
  totalUsd: number;
  entryCount: number;
  missionCount: number;
  since?: string;
  budgetUsd?: number;
  remainingUsd?: number | null;
  overBudget: boolean;
  missionBreakdown: Array<{
    missionId: string;
    tokens: number;
    usd: number;
    entryCount: number;
    lastSeen?: string;
  }>;
}

export interface OperatorHomeWorkforceSummary {
  activeAssignments: number;
  humanResources: number;
  agentResources: number;
  serviceResources: number;
  accountableOwners: string[];
}

/**
 * NI-05 NHI ledger digest for the operator packet: counts by lifecycle state
 * plus the orphans (identities outliving their scope) by name — an orphan is
 * a decision the operator has to make, so it is never reduced to a count.
 */
export interface OperatorHomeNhiLedgerSummary {
  total: number;
  active: number;
  suspended: number;
  retired: number;
  orphanCount: number;
  orphans: Array<{
    nhiId: string;
    accountableHumanId: string;
    reason: string;
    missingScopeId: string;
  }>;
}

export interface OperatorHomeActionItem {
  actionId: string;
  kind: 'mission' | 'approval' | 'deliverable';
  title: string;
  missionId?: string;
  status: string;
  priority: number;
  nextAction: string;
}

export interface OperatorHomeQualitySummary {
  reportId: string;
  projectId: string;
  subjectRef: string;
  recommendation: 'go' | 'conditional_go' | 'no_go' | 'insufficient_evidence';
  humanDecision: 'pending' | 'approved' | 'rejected';
  accountableHumanId: string;
  generatedAt: string;
  residualRisks: string[];
  evidenceRefs: string[];
}

export type OperatorHomeApprovalItem = ReturnType<typeof listApprovalRequests>[number];

export interface OperatorHomeSummary {
  generatedAt: string;
  status: 'ready' | 'attention' | 'blocked';
  statusLabel: string;
  statusDetail: string;
  counts: {
    activeMissions: number;
    /** Active missions with any state change in the last 7 days — the honest
     * "actually moving" number (long-lived active states accumulate). */
    recentlyActiveMissions: number;
    blockedMissions: number;
    pendingApprovals: number;
    clarificationQuestions: number;
    unreadInbox: number;
    totalInbox: number;
    pendingQualityDecisions: number;
  };
  activeMissions: OperatorHomeMissionItem[];
  pendingApprovals: OperatorHomeApprovalItem[];
  inboxEntries: DeliverableInboxEntry[];
  costSummary: OperatorHomeCostSummary;
  workforceSummary?: OperatorHomeWorkforceSummary;
  /** NI-05: NHI inventory — who exists, in what state, and which are orphaned. */
  nhiLedger?: OperatorHomeNhiLedgerSummary;
  actionQueue?: OperatorHomeActionItem[];
  qualitySummary?: OperatorHomeQualitySummary;
  nextAction: NextAction;
}

export interface OperatorHomeScopeFilter {
  tiers?: Array<'personal' | 'confidential' | 'public'> | 'all';
  tenantSlugs?: string[] | 'all';
  organizationIds?: string[] | 'all';
  projectIds?: string[] | 'all';
}

function scopeAllows(allowed: string[] | 'all' | undefined, value: string | undefined): boolean {
  if (allowed === 'all' || allowed === undefined) return true;
  return Boolean(value && allowed.includes(value));
}

function missionMatchesScope(
  mission: Pick<OperatorHomeMissionItem, 'tier' | 'tenantSlug' | 'organizationId' | 'projectId'>,
  scope?: OperatorHomeScopeFilter
): boolean {
  return (
    scopeAllows(scope?.tiers, mission.tier) &&
    scopeAllows(scope?.tenantSlugs, mission.tenantSlug) &&
    scopeAllows(scope?.organizationIds, mission.organizationId) &&
    scopeAllows(scope?.projectIds, mission.projectId)
  );
}

/**
 * NI-05: NHI inventory for the operator packet. Never throws and never blocks
 * the home summary — an unreadable identity ledger degrades to `undefined`
 * (the report already logs the read failure).
 */
function collectNhiLedgerSummary(): OperatorHomeNhiLedgerSummary | undefined {
  try {
    const report = buildNhiLedgerReport();
    if (report.total === 0 && report.orphans.length === 0) return undefined;
    return {
      total: report.total,
      active: report.by_status.active,
      suspended: report.by_status.suspended,
      retired: report.by_status.retired,
      orphanCount: report.orphans.length,
      orphans: report.orphans.map((orphan) => ({
        nhiId: orphan.nhi_id,
        accountableHumanId: orphan.accountable_human_id,
        reason: orphan.reason,
        missingScopeId: orphan.missing_scope_id,
      })),
    };
  } catch {
    return undefined;
  }
}

function collectQualitySummary(): OperatorHomeQualitySummary | undefined {
  const reportPath = pathResolver.shared('runtime/qa/latest-quality-report.json');
  if (!safeExistsSync(reportPath)) return undefined;
  try {
    const report = loadJson<{
      report_id?: string;
      project_id?: string;
      subject_ref?: string;
      recommendation?: OperatorHomeQualitySummary['recommendation'];
      human_decision?: OperatorHomeQualitySummary['humanDecision'];
      accountable_human_id?: string;
      generated_at?: string;
      residual_risks?: string[];
      evidence_refs?: string[];
    }>(reportPath);
    if (!report.report_id || !report.recommendation || !report.accountable_human_id)
      return undefined;
    return {
      reportId: report.report_id,
      projectId: report.project_id ?? '',
      subjectRef: report.subject_ref ?? '',
      recommendation: report.recommendation,
      humanDecision: report.human_decision ?? 'pending',
      accountableHumanId: report.accountable_human_id,
      generatedAt: report.generated_at ?? '',
      residualRisks: report.residual_risks ?? [],
      evidenceRefs: report.evidence_refs ?? [],
    };
  } catch {
    return undefined;
  }
}

function readMissionManagementDirs(): string[] {
  const configPath = pathResolver.knowledge('product/governance/mission-management-config.json');
  if (safeExistsSync(configPath)) {
    try {
      const raw = loadJson<{
        directories?: Record<string, string>;
      }>(configPath);
      const dirs = raw.directories || {};
      return ['personal', 'confidential', 'public']
        .map((tier) => dirs[tier])
        .filter((value): value is string => Boolean(value))
        .map((value) => pathResolver.rootResolve(value));
    } catch {
      // fall back to defaults
    }
  }

  return [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
    pathResolver.active('archive/missions'),
  ];
}

function collectMissionStates(scope?: OperatorHomeScopeFilter): OperatorHomeMissionItem[] {
  const missions: OperatorHomeMissionItem[] = [];
  const artifactRecords = listArtifactRecords();
  for (const root of readMissionManagementDirs()) {
    if (!safeExistsSync(root)) continue;
    try {
      for (const entry of safeReaddir(root)) {
        const statePath = path.join(root, entry, 'mission-state.json');
        if (!safeExistsSync(statePath)) continue;
        try {
          const state = loadJson<{
            mission_id: string;
            status: string;
            tier: 'personal' | 'confidential' | 'public';
            mission_type?: string;
            tenant_id?: string;
            tenant_slug?: string;
            organization_id?: string;
            project_id?: string;
            assigned_persona?: string;
            relationships?: {
              organization?: { organization_id?: string };
              project?: { project_id?: string };
              track?: { track_id?: string; track_name?: string };
            };
            history?: Array<{ ts: string; event: string }>;
            intent?: {
              goal_summary?: string;
              success_condition?: string;
            };
          }>(statePath);
          if (!state?.mission_id) continue;
          const organizationId =
            state.organization_id || state.relationships?.organization?.organization_id;
          const projectId = state.project_id || state.relationships?.project?.project_id;
          if (
            !missionMatchesScope(
              { tier: state.tier, tenantSlug: state.tenant_slug, organizationId, projectId },
              scope
            )
          ) {
            continue;
          }
          const lastEvent = state.history?.[state.history.length - 1];
          const missionArtifacts = artifactRecords.filter(
            (artifact) => artifact.mission_id === state.mission_id
          );
          missions.push({
            missionId: state.mission_id,
            status: state.status,
            tier: state.tier,
            missionType: state.mission_type,
            tenantSlug: state.tenant_slug,
            tenantId: state.tenant_id,
            organizationId,
            persona: state.assigned_persona,
            projectId,
            trackId: state.relationships?.track?.track_id,
            trackName: state.relationships?.track?.track_name,
            updatedAt: lastEvent?.ts || state.history?.[0]?.ts,
            goalSummary: state.intent?.goal_summary,
            successCondition: state.intent?.success_condition,
            artifactKinds: Array.from(
              new Set(missionArtifacts.map((artifact) => artifact.kind).filter(Boolean))
            ),
            artifactCount: missionArtifacts.length,
          });
        } catch {
          // ignore malformed mission state files
        }
      }
    } catch {
      // ignore inaccessible roots
    }
  }
  return missions.sort((left, right) =>
    (right.updatedAt || '').localeCompare(left.updatedAt || '')
  );
}

function getMetricTokens(entry: Record<string, any>): number {
  const usage = entry.usage || {};
  const promptTokens = Number(entry.prompt_tokens ?? usage.prompt_tokens ?? 0);
  const completionTokens = Number(entry.completion_tokens ?? usage.completion_tokens ?? 0);
  return Math.max(0, promptTokens + completionTokens);
}

function getMetricCost(entry: Record<string, any>): number {
  const directCost = Number(
    entry.cost_usd ?? entry.sdk_cost_usd ?? entry.total_cost_usd ?? entry.estimated_cost_usd ?? 0
  );
  if (Number.isFinite(directCost) && directCost > 0) return directCost;
  const tokens = getMetricTokens(entry);
  if (tokens <= 0) return 0;
  return Number(entry.estimated_cost_usd ?? 0);
}

function collectCostSummary(
  input: {
    missionId?: string;
    missionIds?: string[];
    since?: string;
    budgetUsd?: number;
  } = {}
): OperatorHomeCostSummary {
  const history = new MetricsCollector({ persist: false }).loadHistory();
  const sinceIso = input.since || '';
  const missionFilter = (input.missionId || '').trim().toUpperCase();
  const missionIds = input.missionIds
    ? new Set(input.missionIds.map((missionId) => missionId.trim().toUpperCase()))
    : undefined;
  const entries = history.filter((entry) => {
    const entryMissionId = String(entry.mission_id || entry.missionId || '').toUpperCase();
    if (missionFilter && entryMissionId !== missionFilter) return false;
    if (missionIds && !missionIds.has(entryMissionId)) return false;
    if (sinceIso && String(entry.timestamp || entry.ts || '') < sinceIso) return false;
    return true;
  });

  const byMission = new Map<
    string,
    { missionId: string; tokens: number; usd: number; entryCount: number; lastSeen?: string }
  >();

  let totalTokens = 0;
  let totalUsd = 0;
  for (const entry of entries) {
    const missionId = String(entry.mission_id || entry.missionId || 'UNASSIGNED').toUpperCase();
    const tokens = getMetricTokens(entry);
    const usd = getMetricCost(entry);
    const record = byMission.get(missionId) || {
      missionId,
      tokens: 0,
      usd: 0,
      entryCount: 0,
      lastSeen: undefined,
    };
    record.tokens += tokens;
    record.usd += usd;
    record.entryCount += 1;
    record.lastSeen = String(entry.timestamp || entry.ts || record.lastSeen || '');
    byMission.set(missionId, record);
    totalTokens += tokens;
    totalUsd += usd;
  }

  const budgetUsd =
    typeof input.budgetUsd === 'number' && Number.isFinite(input.budgetUsd) && input.budgetUsd > 0
      ? input.budgetUsd
      : undefined;
  const remainingUsd =
    typeof budgetUsd === 'number'
      ? Math.max(0, Math.round((budgetUsd - totalUsd) * 1000) / 1000)
      : null;

  return {
    totalTokens,
    totalUsd: Math.round(totalUsd * 1000) / 1000,
    entryCount: entries.length,
    missionCount: byMission.size,
    since: sinceIso || undefined,
    budgetUsd,
    remainingUsd,
    overBudget: typeof budgetUsd === 'number' ? totalUsd > budgetUsd : false,
    missionBreakdown: Array.from(byMission.values()).sort((left, right) => right.usd - left.usd),
  };
}

function collectWorkforceSummary(
  missions: OperatorHomeMissionItem[]
): OperatorHomeWorkforceSummary {
  const resources = new Map<string, 'human' | 'agent' | 'service'>();
  const owners = new Set<string>();
  let activeAssignments = 0;
  for (const mission of missions) {
    const staffing = loadMissionStaffingAssignments(mission.missionId);
    for (const assignment of staffing?.assignments || []) {
      if (assignment.status !== 'active') continue;
      activeAssignments += 1;
      resources.set(assignment.resource.resource_id, assignment.resource.resource_type);
      if (assignment.resource.accountable_human_id)
        owners.add(assignment.resource.accountable_human_id);
    }
  }
  return {
    activeAssignments,
    humanResources: [...resources.values()].filter((type) => type === 'human').length,
    agentResources: [...resources.values()].filter((type) => type === 'agent').length,
    serviceResources: [...resources.values()].filter((type) => type === 'service').length,
    accountableOwners: [...owners].sort(),
  };
}

function collectActionQueue(
  missions: OperatorHomeMissionItem[],
  approvals: OperatorHomeApprovalItem[],
  inboxEntries: DeliverableInboxEntry[]
): OperatorHomeActionItem[] {
  const items: OperatorHomeActionItem[] = [];
  for (const mission of missions.filter(
    (item) => item.status === 'paused' || item.status === 'failed'
  )) {
    items.push({
      actionId: `mission:${mission.missionId}`,
      kind: 'mission',
      title: mission.goalSummary || mission.missionId,
      missionId: mission.missionId,
      status: mission.status,
      priority: 100,
      nextAction: 'Inspect and recover the mission',
    });
  }
  for (const approval of approvals) {
    items.push({
      actionId: `approval:${approval.id}`,
      kind: 'approval',
      title: approval.title,
      missionId: approval.requestedByContext?.missionId,
      status: approval.status,
      priority: approval.severity === 'high' ? 95 : 80,
      nextAction: 'Review and decide',
    });
  }
  for (const entry of inboxEntries.filter(
    (item) => item.status === 'unread' || item.status === 'changes_requested'
  )) {
    items.push({
      actionId: `deliverable:${entry.entry_id}`,
      kind: 'deliverable',
      title: entry.title,
      missionId: entry.mission_id,
      status: entry.status,
      priority: entry.status === 'changes_requested' ? 85 : 60,
      nextAction:
        entry.status === 'changes_requested' ? 'Review requested changes' : 'Review deliverable',
    });
  }
  return items.sort(
    (left, right) => right.priority - left.priority || left.actionId.localeCompare(right.actionId)
  );
}

export function collectOperatorHomeSummary(
  input: {
    budgetUsd?: number;
    since?: string;
    limit?: number;
    scope?: OperatorHomeScopeFilter;
  } = {}
): OperatorHomeSummary {
  const missionItems = collectMissionStates(input.scope);
  const scopedMissionIds = new Set(missionItems.map((mission) => mission.missionId.toUpperCase()));
  const isScoped = Boolean(
    input.scope &&
    [
      input.scope.tiers,
      input.scope.tenantSlugs,
      input.scope.organizationIds,
      input.scope.projectIds,
    ].some((allowed) => Array.isArray(allowed))
  );
  const approvalMatchesScope = (approval: OperatorHomeApprovalItem): boolean => {
    if (!input.scope || !isScoped) return true;
    const scope = approval.scope;
    const missionId =
      scope?.mission_id || approval.requestedByContext?.missionId || approval.steering?.missionId;
    const tenantSlug = scope?.tenant_slug;
    const tier = scope?.tier;
    const organizationId = scope?.organization_id;
    const projectId = scope?.project_id;
    if (scope?.tier || scope?.tenant_slug || scope?.organization_id || scope?.project_id) {
      if (Array.isArray(input.scope.tiers) && !scopeAllows(input.scope.tiers, tier)) {
        return Boolean(missionId && scopedMissionIds.has(missionId.toUpperCase()));
      }
      return (
        scopeAllows(input.scope.tenantSlugs, tenantSlug) &&
        scopeAllows(input.scope.organizationIds, organizationId) &&
        scopeAllows(input.scope.projectIds, projectId)
      );
    }
    return Boolean(missionId && scopedMissionIds.has(missionId.toUpperCase()));
  };
  const inboxMatchesScope = (entry: DeliverableInboxEntry): boolean => {
    if (!input.scope || !isScoped) return true;
    if (Array.isArray(input.scope.tiers)) {
      if (!entry.mission_id) return false;
      if (!scopedMissionIds.has(entry.mission_id.toUpperCase())) return false;
    }
    if (!scopeAllows(input.scope.tenantSlugs, entry.tenant_slug)) return false;
    if (Array.isArray(input.scope.organizationIds) || Array.isArray(input.scope.projectIds)) {
      return Boolean(entry.mission_id && scopedMissionIds.has(entry.mission_id.toUpperCase()));
    }
    return true;
  };
  const activeMissions = missionItems.filter((item) => item.status === 'active');
  const blockedMissions = missionItems.filter(
    (item) => item.status === 'paused' || item.status === 'failed'
  );
  const pendingApprovals = listApprovalRequests({ status: 'pending' })
    .filter(approvalMatchesScope)
    .slice(0, input.limit || 8);
  const inboxEntries = listInboxEntries({ limit: isScoped ? 10000 : input.limit || 8 })
    .filter(inboxMatchesScope)
    .slice(0, input.limit || 8);
  const unreadInbox = inboxEntries.filter((entry) => entry.status === 'unread').length;
  const clarificationQuestions = 0;
  const costSummary = collectCostSummary({
    budgetUsd: input.budgetUsd,
    since: input.since,
    ...(isScoped ? { missionIds: [...scopedMissionIds] } : {}),
  });
  const workforceSummary = collectWorkforceSummary(missionItems);
  const nhiLedger = collectNhiLedgerSummary();
  const actionQueue = collectActionQueue(missionItems, pendingApprovals, inboxEntries);
  const qualitySummary = collectQualitySummary();
  const pendingQualityDecisions = qualitySummary?.humanDecision === 'pending' ? 1 : 0;
  const status =
    blockedMissions.length > 0
      ? 'blocked'
      : pendingApprovals.length > 0 || unreadInbox > 0 || pendingQualityDecisions > 0
        ? 'attention'
        : 'ready';
  const statusLabel =
    status === 'blocked' ? 'blocked' : status === 'attention' ? 'attention required' : 'ready';
  const statusDetail =
    status === 'blocked'
      ? `${blockedMissions.length} mission(s) are paused or failed.`
      : status === 'attention'
        ? `${pendingApprovals.length} approval(s), ${unreadInbox} inbox item(s), and ${pendingQualityDecisions} quality decision(s) need attention.`
        : 'No blocking issues detected.';

  const nextAction =
    blockedMissions.length > 0
      ? buildNextAction({
          title: 'Inspect blocked missions',
          reason: `${blockedMissions.length} mission(s) need recovery before the surface should be treated as clear.`,
          next_action_type: 'inspect_artifact',
          suggested_command: 'pnpm mission list --active',
        })
      : pendingApprovals.length > 0
        ? buildNextAction({
            title: 'Review the approval queue',
            reason: `${pendingApprovals.length} approval request(s) are waiting for operator review.`,
            next_action_type: 'run_command',
            suggested_command: 'pnpm kyberion approvals',
          })
        : pendingQualityDecisions > 0
          ? buildNextAction({
              title: 'Review the software quality recommendation',
              reason: `${qualitySummary?.recommendation ?? 'unknown'} is awaiting the accountable human decision.`,
              next_action_type: 'inspect_artifact',
              suggested_command: 'pnpm quality:report -- --help',
            })
          : unreadInbox > 0
            ? buildNextAction({
                title: 'Acknowledge new deliverables',
                reason: `${unreadInbox} inbox item(s) were delivered and are still unread.`,
                next_action_type: 'inspect_artifact',
                suggested_command: 'pnpm kyberion inbox',
              })
            : buildNextAction({
                title: 'Keep monitoring the surface',
                reason: 'No immediate operator action is pending.',
                next_action_type: 'open_docs',
                suggested_command: 'pnpm doctor',
              });

  return {
    generatedAt: new Date().toISOString(),
    status,
    statusLabel,
    statusDetail,
    counts: {
      activeMissions: activeMissions.length,
      recentlyActiveMissions: activeMissions.filter((item) => {
        const updated = Date.parse(String(item.updatedAt || ''));
        return Number.isFinite(updated) && Date.now() - updated < 7 * 24 * 60 * 60 * 1000;
      }).length,
      blockedMissions: blockedMissions.length,
      pendingApprovals: pendingApprovals.length,
      clarificationQuestions,
      unreadInbox,
      totalInbox: inboxEntries.length,
      pendingQualityDecisions,
    },
    activeMissions: activeMissions.slice(0, input.limit || 8),
    pendingApprovals,
    inboxEntries,
    costSummary,
    workforceSummary,
    nhiLedger,
    actionQueue,
    qualitySummary,
    nextAction,
  };
}
