import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import { provisionMissionEntry, writeProvisionedJson } from './mission-orchestration-journal.js';
import * as pathResolver from './path-resolver.js';
import {
  selectAgentForTeamRole,
  type MissionTeamAssignment,
  type RoleSeparationConstraints,
  type TeamProviderPreference,
} from './team-role-assignment-selection.js';
import { resolveTaskModelHint } from './reasoning-model-routing.js';
import { collectWorkforceLoad } from './workforce-load.js';
import {
  matchTeamCompositionObligations,
  resolveAlwaysStaffedRoles,
  resolveRosterHeadroom,
  type MatchedTeamCompositionObligation,
} from './team-composition-obligations.js';
import {
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
  type MissionClassification,
} from './mission-classification.js';
import {
  loadAgentProfileIndex,
  loadAuthorityRoleIndex,
  loadMissionTeamTemplates,
  loadTeamRoleIndex,
} from './mission-team-index.js';
import { loadOrganizationProfile, type OrganizationProfile } from './organization-profile.js';
import {
  resolveOrganizationOrgChart,
  summarizeOrganizationOrgChart,
  type OrganizationOrgChartSummary,
} from './org-chart.js';
import { resolveParticipantContext, type ParticipantRisk } from './participant-context-resolver.js';
import { discoverProviders } from './provider-discovery.js';
import { isObsoleteAgentRuntimeProvider } from './provider-config.js';
import type { ScopeContext } from './scope-context.js';

export interface MissionTeamPlan {
  mission_id: string;
  mission_type: string;
  tier: string;
  tenant_slug?: string;
  provider_selection?: {
    requested_provider?: string;
    requested_model_id?: string;
    available_providers: string[];
  };
  template: string;
  assigned_persona?: string;
  organization_profile?: MissionTeamOrganizationProfileSummary;
  organization_chart?: OrganizationOrgChartSummary;
  mission_classification?: MissionClassification;
  generated_at: string;
  team_governance?: MissionTeamGovernance;
  assignments: MissionTeamAssignment[];
}

const MISSION_TEAM_PLAN_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-team-plan.schema.json'
);

function missionTeamPlanCatalog(filePath: string) {
  return defineCatalog<MissionTeamPlan>({
    id: 'mission-team-plan',
    path: filePath,
    schema: MISSION_TEAM_PLAN_SCHEMA_PATH,
  });
}

/** Load one persisted team plan through the shared schema and mission boundary. */
export function loadMissionTeamPlanAtPath(filePath: string, missionId: string): MissionTeamPlan {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MISSION_TEAM_PLAN] plan must be a regular file: ${filePath}`);
  }
  const plan = missionTeamPlanCatalog(safeFilePath).load();
  const expectedMissionId = missionId.trim().toUpperCase();
  if (plan.mission_id.trim().toUpperCase() !== expectedMissionId) {
    throw new Error(
      `[MISSION_TEAM_PLAN_SCOPE_MISMATCH] plan belongs to ${plan.mission_id}, expected ${expectedMissionId}`
    );
  }
  return plan;
}

export interface MissionTeamOrganizationProfileSummary {
  organization_id: string;
  name: string;
  default_team_template?: string;
  team_template_catalog_id?: string;
  default_agent_profile?: string;
}

export interface MissionTeamLifecyclePolicy {
  max_parallel_members: number;
  max_members: number;
  max_messages_per_run: number;
  max_wall_clock_minutes: number;
  max_member_turns: number;
  max_followup_iterations: number;
  max_rework_attempts: number;
  max_review_rounds: number;
  shutdown_policy: 'graceful_handoff' | 'manual' | 'auto_shutdown';
  resume_policy: 'checkpoint_resume' | 'manual_resume';
  cooldown_minutes: number;
}

export interface MissionTeamCompositionSummary {
  required_roles: string[];
  optional_roles: string[];
  /** Roles staffed right now (status `assigned`). */
  assigned_roles: string[];
  /** TC-01: roster roles with a resolved candidate that are not staffed yet. */
  standby_roles?: string[];
  /** Required roles with no compatible actor in the pool — a real gap. */
  unfilled_required_roles: string[];
}

export interface MissionTeamGovernance {
  lifecycle: MissionTeamLifecyclePolicy;
  composition: MissionTeamCompositionSummary;
  /**
   * TC-04: the obligations this mission's classification matched, so an audit
   * reads why each derived role is on the roster instead of inferring it from
   * the template name.
   */
  obligations?: MatchedTeamCompositionObligation[];
}

interface MissionTeamTemplateRecord {
  required_roles: string[];
  optional_roles: string[];
  lifecycle?: Partial<MissionTeamLifecyclePolicy>;
}

export interface ResolveMissionTeamOptions {
  missionId: string;
  missionType?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  utterance?: string;
  artifactPaths?: string[];
  progressSignals?: string[];
  tier?: 'personal' | 'confidential' | 'public';
  assignedPersona?: string;
  tenantSlug?: string;
  organizationProfile?: OrganizationProfile | null;
  scope?: ScopeContext;
  forceRefresh?: boolean;
  providerPreference?: TeamProviderPreference;
}

function loadMissionTenantSlug(missionId: string): string | undefined {
  const missionPath = pathResolver.findMissionPath(missionId.toUpperCase());
  if (!missionPath) return undefined;
  let statePath: string;
  try {
    statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'), {
      allowMissingLeaf: false,
    });
  } catch {
    return undefined;
  }
  if (!safeExistsSync(statePath)) return undefined;
  return loadMissionStateAtPath(statePath)?.tenant_slug?.trim() || undefined;
}

function resolveAvailableTeamProviders(): string[] {
  return discoverProviders()
    .filter(
      (entry) => entry.installed && entry.healthy && !isObsoleteAgentRuntimeProvider(entry.provider)
    )
    .map((entry) => entry.provider)
    .sort();
}

function normalizeTeamProviderPreference(
  preference?: TeamProviderPreference
): TeamProviderPreference | undefined {
  if (!preference?.provider?.trim()) return undefined;
  const normalized: TeamProviderPreference = {
    provider: preference.provider.trim().toLowerCase(),
    ...(preference.modelId?.trim() ? { modelId: preference.modelId.trim() } : {}),
    strategy: preference.strategy || 'strict',
  };
  const availableProviders = resolveAvailableTeamProviders();
  if (!availableProviders.includes(normalized.provider)) {
    throw new Error(
      `[TEAM_PROVIDER_UNAVAILABLE] Requested provider '${normalized.provider}' is not available for team composition. Available providers: ${availableProviders.join(', ') || 'none'}.`
    );
  }
  return normalized;
}

function buildTeamGovernance(
  template: MissionTeamTemplateRecord,
  assignments: MissionTeamAssignment[],
  obligations: MatchedTeamCompositionObligation[] = []
): MissionTeamGovernance {
  const rosterSize = template.required_roles.length + template.optional_roles.length;
  const lifecycle: MissionTeamLifecyclePolicy = {
    max_parallel_members: template.required_roles.length,
    max_members: rosterSize,
    max_messages_per_run: 40,
    max_wall_clock_minutes: 120,
    max_member_turns: 8,
    max_followup_iterations: 20,
    max_rework_attempts: 1,
    max_review_rounds: 2,
    shutdown_policy: 'graceful_handoff',
    resume_policy: 'checkpoint_resume',
    cooldown_minutes: 5,
    ...template.lifecycle,
  };
  // TC-06: every authored template declares `max_members` equal to its own
  // roster size, which makes the cap unreachable by construction and blocks
  // any legitimate mid-mission restaffing. Derive a real ceiling instead:
  // the declared value or the composed roster plus the governed headroom,
  // whichever is larger. This also keeps the cap coherent when obligations
  // add roles the template never listed.
  lifecycle.max_members = Math.max(lifecycle.max_members, rosterSize + resolveRosterHeadroom());
  const assignedRoles = assignments
    .filter((entry) => entry.status === 'assigned')
    .map((entry) => entry.team_role);
  const standbyRoles = assignments
    .filter((entry) => entry.status === 'standby')
    .map((entry) => entry.team_role);
  // TC-01: a standby role is staffed on demand and is not a gap. Only a role
  // with no compatible actor in the pool counts as unfilled.
  const unfilledRequiredRoles = assignments
    .filter((entry) => entry.required && entry.status === 'unfilled')
    .map((entry) => entry.team_role);
  return {
    lifecycle,
    ...(obligations.length > 0 ? { obligations } : {}),
    composition: {
      required_roles: [...template.required_roles],
      optional_roles: [...template.optional_roles],
      assigned_roles: assignedRoles,
      standby_roles: standbyRoles,
      unfilled_required_roles: unfilledRequiredRoles,
    },
  };
}

function enrichAssignmentContext(input: {
  assignment: MissionTeamAssignment;
  missionId: string;
  tier: 'personal' | 'confidential' | 'public';
  tenantId: string;
  risk: string;
}): MissionTeamAssignment {
  const assignment = input.assignment;
  if (assignment.status !== 'assigned' || !assignment.agent_id || !assignment.authority_role) {
    return assignment;
  }
  const participantId = `${assignment.agent_id}:${assignment.team_role}`;
  const resolution = resolveParticipantContext({
    participant_id: participantId,
    team_role_id: assignment.team_role,
    agent_profile_id: assignment.agent_id,
    authority_role_id: assignment.authority_role,
    risk: input.risk as ParticipantRisk,
    security_scope: {
      tenant_id: input.tenantId,
      mission_id: input.missionId,
      participant_id: participantId,
      read_tiers:
        input.tier === 'public'
          ? ['public']
          : input.tier === 'confidential'
            ? ['public', 'confidential']
            : ['public', 'personal'],
      write_tier: input.tier,
      purpose: assignment.team_role,
      external_egress: input.tier === 'public' ? 'allow' : 'deny',
    },
  });
  return {
    ...assignment,
    organization_role_id: resolution.participant.organization_role_id,
    perspective_ids: resolution.participant.perspective_ids,
    reasoning_route_id: resolution.participant.reasoning_route_id,
    security_scope: resolution.participant.security_scope,
    selection_reason_codes: resolution.selection_reason_codes,
  };
}

export function summarizeMissionOrganizationProfile(
  organizationProfile?: OrganizationProfile | null
): MissionTeamOrganizationProfileSummary | undefined {
  if (!organizationProfile) return undefined;
  return {
    organization_id: organizationProfile.organization_id,
    name: organizationProfile.name,
    default_team_template:
      organizationProfile.mission_defaults?.default_team_template ||
      organizationProfile.team_defaults?.default_team_template,
    team_template_catalog_id: organizationProfile.team_defaults?.team_template_catalog_id,
    default_agent_profile: organizationProfile.mission_defaults?.default_agent_profile,
  };
}

interface RoleHolder {
  agentId: string | null;
  provider: string | null;
}

/**
 * Separation-of-duties constraints derived from the roles a plan has already
 * filled: the reviewer must be a different actor than the implementer (hard,
 * with a staffing fallback) and prefers a different provider so a different
 * model family reviews the work; the tester prefers a different actor than the
 * reviewer; the researcher must differ from the owner.
 *
 * Shared by initial composition and by TC-06 restaffing so a member added
 * mid-mission is held to the same independence rules as one selected at
 * creation.
 */
function resolveRoleSeparation(
  role: string,
  holders: Map<string, RoleHolder>
): RoleSeparationConstraints | undefined {
  if (role === 'researcher') {
    const owner = holders.get('owner');
    if (!owner) return undefined;
    return { excludeAgents: [owner.agentId], avoidProviders: [owner.provider] };
  }
  if (role === 'reviewer') {
    const implementer = holders.get('implementer');
    if (!implementer) return undefined;
    return { excludeAgents: [implementer.agentId], avoidProviders: [implementer.provider] };
  }
  if (role === 'tester') {
    const reviewer = holders.get('reviewer');
    if (!reviewer) return undefined;
    return { avoidAgents: [reviewer.agentId] };
  }
  return undefined;
}

/**
 * TC-01: demand-driven staffing.
 *
 * Composition resolves a candidate actor for every roster role — that is what
 * keeps a staffing gap visible at creation time — but only the structural
 * roles start staffed. Everything else waits on standby until work demands
 * it, so a mission no longer carries staffing records, provisioned identities
 * and runtime slots for roles it never uses. Promotion is a pure state
 * transition over the already-selected candidate (see
 * `promoteMissionTeamPlanRoles`), so it never re-runs selection.
 */
function applyStaffingPolicy(assignments: MissionTeamAssignment[]): MissionTeamAssignment[] {
  const alwaysStaffedRoles = resolveAlwaysStaffedRoles();
  return assignments.map((assignment) =>
    assignment.status === 'assigned' && !alwaysStaffedRoles.has(assignment.team_role)
      ? { ...assignment, status: 'standby' as const }
      : assignment
  );
}

export function composeMissionTeamPlan(input: {
  missionId: string;
  missionType?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  utterance?: string;
  artifactPaths?: string[];
  progressSignals?: string[];
  tier: 'personal' | 'confidential' | 'public';
  assignedPersona?: string;
  tenantSlug?: string;
  organizationProfile?: OrganizationProfile | null;
  scope?: ScopeContext;
  providerPreference?: TeamProviderPreference;
}): MissionTeamPlan {
  const organizationProfile = input.organizationProfile ?? loadOrganizationProfile();
  const tenantSlug = input.tenantSlug?.trim() || 'default';
  const providerPreference = normalizeTeamProviderPreference(input.providerPreference);
  const availableProviders = providerPreference ? resolveAvailableTeamProviders() : [];
  const compositionScope =
    input.scope ??
    (tenantSlug !== 'default'
      ? {
          tier: input.tier,
          tenant_slug: tenantSlug,
          ...(organizationProfile?.organization_id
            ? { organization_id: organizationProfile.organization_id }
            : {}),
        }
      : undefined);
  const missionClassification = resolveMissionClassification({
    missionTypeHint: input.missionType,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    utterance: input.utterance,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
  });
  const missionType =
    input.missionType || mapMissionClassToMissionTypeTemplate(missionClassification.mission_class);
  const templates = loadMissionTeamTemplates(organizationProfile, compositionScope);
  const teamRoles = loadTeamRoleIndex();
  const authorityRoles = loadAuthorityRoleIndex();
  const agents = loadAgentProfileIndex();
  const organizationChart = summarizeOrganizationOrgChart(
    resolveOrganizationOrgChart(organizationProfile?.organization_id || null)
  );
  const organizationDefaultTemplate = organizationProfile?.mission_defaults?.default_team_template;
  const template = (templates[missionType] ||
    (organizationDefaultTemplate ? templates[organizationDefaultTemplate] : undefined) ||
    templates.default) as MissionTeamTemplateRecord;
  const assignments: MissionTeamAssignment[] = [];
  // TC-09: one pass over the work-item store for the whole composition, so
  // every role is scored against the same observed load snapshot.
  const loadIndex = collectWorkforceLoad();
  const preferredAgentId = organizationProfile?.mission_defaults?.default_agent_profile
    ?.trim()
    .toLowerCase();
  const missionTaskModelHint = resolveTaskModelHint({
    phase_kind:
      missionClassification.stage === 'planning' ||
      missionClassification.stage === 'contract_authoring'
        ? 'plan'
        : missionClassification.stage === 'verification' ||
            missionClassification.stage === 'retrospective'
          ? 'review'
          : missionClassification.stage === 'execution'
            ? 'implement'
            : 'mechanical',
    estimated_scope:
      missionClassification.delivery_shape === 'long_running_job' ||
      missionClassification.delivery_shape === 'cross_system_change'
        ? 'L'
        : missionClassification.delivery_shape === 'single_artifact'
          ? 'S'
          : 'M',
    risk: missionClassification.risk_profile,
  });

  const assignedByRole = new Map<string, RoleHolder>();
  const separationForRole = (role: string): RoleSeparationConstraints | undefined =>
    resolveRoleSeparation(role, assignedByRole);
  const recordAssignment = (
    role: string,
    assignment: { agent_id: string | null; provider: string | null }
  ): void => {
    assignedByRole.set(role, {
      agentId: assignment.agent_id,
      provider: assignment.provider,
    });
  };

  // TC-04: the roster is the template (an organization's preference) plus the
  // roles the governed obligations catalog derives from this mission's
  // classification. An obligation role is required even when the template
  // lists it as optional or omits it entirely, so a template or organization
  // overlay cannot drop a role that governance requires.
  const matchedObligations = matchTeamCompositionObligations({
    classification: missionClassification,
    tier: input.tier,
  });
  const obligatoryRoles = new Set(
    matchedObligations.flatMap((obligation) => obligation.require_roles)
  );
  const structuralRoles = resolveAlwaysStaffedRoles();
  // Template order first so separation-of-duties stays resolvable (a reviewer
  // is selected after the implementer it must be independent of); roles that
  // only an obligation contributes are appended in catalog order.
  const effectiveRequiredRoles = [
    ...template.required_roles,
    ...Array.from(obligatoryRoles).filter((role) => !template.required_roles.includes(role)),
  ];
  const effectiveOptionalRoles = template.optional_roles.filter(
    (role) => !effectiveRequiredRoles.includes(role)
  );
  const effectiveTemplate: MissionTeamTemplateRecord = {
    ...template,
    required_roles: effectiveRequiredRoles,
    optional_roles: effectiveOptionalRoles,
  };

  const resolveRoleSources = (role: string): NonNullable<MissionTeamAssignment['role_sources']> => {
    const sources: NonNullable<MissionTeamAssignment['role_sources']> = [];
    if (structuralRoles.has(role)) sources.push('structural');
    if (obligatoryRoles.has(role)) sources.push('obligation');
    if (template.required_roles.includes(role) || template.optional_roles.includes(role)) {
      sources.push('template');
    }
    return sources.length > 0 ? sources : ['template'];
  };

  const roster = [
    ...effectiveRequiredRoles.map((role) => ({ role, required: true })),
    ...effectiveOptionalRoles.map((role) => ({ role, required: false })),
  ];

  for (const { role, required } of roster) {
    const roleRecord = teamRoles[role];
    if (!roleRecord) {
      // An unknown optional role is simply absent; an unknown required role is
      // a declared gap the mission must see.
      if (!required) continue;
      assignments.push({
        team_role: role,
        required: true,
        status: 'unfilled',
        agent_id: null,
        authority_role: null,
        delegation_contract: null,
        provider: null,
        modelId: null,
        required_capabilities: [],
        notes: 'Team role not found in team-role-index',
        model_hint: missionTaskModelHint,
        role_sources: resolveRoleSources(role),
      });
      continue;
    }

    const selected = selectAgentForTeamRole({
      teamRole: role,
      teamRoleRecord:
        preferredAgentId &&
        !roleRecord.selection_hints?.preferred_agents?.includes(preferredAgentId)
          ? {
              ...roleRecord,
              selection_hints: {
                ...(roleRecord.selection_hints || {}),
                preferred_agents: [
                  preferredAgentId,
                  ...(roleRecord.selection_hints?.preferred_agents || []).filter(
                    (agent) => agent !== preferredAgentId
                  ),
                ],
              },
            }
          : roleRecord,
      authorityRoles,
      agents,
      routingHint: missionTaskModelHint,
      separation: separationForRole(role),
      organizationId: organizationProfile?.organization_id,
      providerPreference,
      loadIndex,
    });
    recordAssignment(role, selected);
    selected.required = required;
    selected.model_hint = missionTaskModelHint;
    selected.role_sources = resolveRoleSources(role);
    assignments.push(
      enrichAssignmentContext({
        assignment: selected,
        missionId: input.missionId,
        tier: input.tier,
        tenantId: tenantSlug,
        risk: missionClassification.risk_profile,
      })
    );
  }

  const staffedAssignments = applyStaffingPolicy(assignments);

  return {
    mission_id: input.missionId,
    mission_type: missionType,
    tier: input.tier,
    tenant_slug: tenantSlug,
    ...(providerPreference
      ? {
          provider_selection: {
            requested_provider: providerPreference.provider,
            ...(providerPreference.modelId
              ? { requested_model_id: providerPreference.modelId }
              : {}),
            available_providers: availableProviders,
          },
        }
      : {}),
    template: templates[missionType]
      ? missionType
      : organizationDefaultTemplate && templates[organizationDefaultTemplate]
        ? organizationDefaultTemplate
        : 'default',
    assigned_persona: input.assignedPersona,
    organization_profile: summarizeMissionOrganizationProfile(organizationProfile),
    organization_chart: organizationChart,
    mission_classification: missionClassification,
    generated_at: nowIso(),
    team_governance: buildTeamGovernance(effectiveTemplate, staffedAssignments, matchedObligations),
    assignments: staffedAssignments,
  };
}

export function enrichMissionTeamPlanWithOrganizationProfile(
  plan: MissionTeamPlan,
  organizationProfile?: OrganizationProfile | null
): MissionTeamPlan {
  const organization_profile = summarizeMissionOrganizationProfile(organizationProfile);
  const organization_chart = summarizeOrganizationOrgChart(
    resolveOrganizationOrgChart(organizationProfile?.organization_id || null)
  );
  const profileMatches =
    !organization_profile ||
    (plan.organization_profile &&
      plan.organization_profile.organization_id === organization_profile.organization_id &&
      plan.organization_profile.name === organization_profile.name &&
      plan.organization_profile.default_team_template ===
        organization_profile.default_team_template &&
      plan.organization_profile.team_template_catalog_id ===
        organization_profile.team_template_catalog_id &&
      plan.organization_profile.default_agent_profile ===
        organization_profile.default_agent_profile);
  const chartMatches =
    !organization_chart ||
    (plan.organization_chart &&
      plan.organization_chart.organization_id === organization_chart.organization_id &&
      plan.organization_chart.name === organization_chart.name &&
      plan.organization_chart.source_kind === organization_chart.source_kind &&
      plan.organization_chart.domain_count === organization_chart.domain_count &&
      plan.organization_chart.position_count === organization_chart.position_count);
  if (profileMatches && chartMatches) {
    return plan;
  }
  return {
    ...plan,
    organization_profile,
    organization_chart,
  };
}

export function writeMissionTeamPlan(missionDir: string, plan: MissionTeamPlan): string {
  const targetPath = assertSafeRepositoryPath(path.join(missionDir, 'team-composition.json'), {
    allowMissingLeaf: true,
  });
  const safeMissionPath = assertSafeRepositoryPath(missionDir, { allowMissingLeaf: true });
  writeProvisionedJson({
    missionId: plan.mission_id,
    filePath: targetPath,
    targetPath: path.relative(safeMissionPath, targetPath).split(path.sep).join('/'),
    missionPathHint: safeMissionPath,
    provisioned: provisionMissionEntry(plan),
  });
  return targetPath;
}

export function getMissionTeamPlanPath(missionId: string): string | null {
  const missionPath = pathResolver.findMissionPath(missionId.toUpperCase());
  if (!missionPath) return null;
  return assertSafeRepositoryPath(path.join(missionPath, 'team-composition.json'), {
    allowMissingLeaf: true,
  });
}

export function loadMissionTeamPlan(missionId: string): MissionTeamPlan | null {
  const planPath = getMissionTeamPlanPath(missionId);
  if (!planPath || !safeExistsSync(planPath)) return null;
  const plan = loadMissionTeamPlanAtPath(planPath, missionId);
  const expectedTenant = loadMissionTenantSlug(missionId);
  if (
    expectedTenant &&
    plan.assignments.some(
      (assignment) =>
        assignment.status !== 'unfilled' && assignment.security_scope?.tenant_id !== expectedTenant
    )
  ) {
    return null;
  }
  if (
    plan.assignments.some(
      (assignment) =>
        assignment.status !== 'unfilled' &&
        isObsoleteAgentRuntimeProvider(assignment.provider || undefined)
    )
  ) {
    return null;
  }
  return plan;
}

export function resolveMissionTeamPlan(input: ResolveMissionTeamOptions): MissionTeamPlan {
  const missionId = input.missionId.toUpperCase();
  const tenantSlug = input.tenantSlug?.trim() || loadMissionTenantSlug(missionId);
  const existing = input.forceRefresh ? null : loadMissionTeamPlan(missionId);
  if (existing && (!tenantSlug || existing.tenant_slug === tenantSlug)) return existing;

  const recomposed = composeMissionTeamPlan({
    missionId,
    missionType: input.missionType,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape,
    utterance: input.utterance,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
    tier: input.tier || 'public',
    assignedPersona: input.assignedPersona,
    ...(tenantSlug ? { tenantSlug } : {}),
    organizationProfile: input.organizationProfile,
    providerPreference: input.providerPreference,
  });

  // TC-01: recomposition must not un-staff members who are already working.
  // A refresh re-derives the roster and may re-select actors, but a role the
  // mission had already staffed stays staffed.
  const previousPlan = existing ?? loadMissionTeamPlan(missionId);
  if (!previousPlan) return recomposed;

  // TC-06: a restaffed member is a recorded governance decision with a ledger
  // entry behind it, not an artifact of the template. Recomposition derives
  // the roster from template + obligations, which would silently drop it, so
  // carry it across.
  const carriedRestaffed = previousPlan.assignments.filter(
    (assignment) =>
      assignment.role_sources?.includes('restaff') &&
      !recomposed.assignments.some((entry) => entry.team_role === assignment.team_role)
  );
  const withRestaffed: MissionTeamPlan = carriedRestaffed.length
    ? {
        ...recomposed,
        assignments: [...recomposed.assignments, ...carriedRestaffed],
        ...(recomposed.team_governance
          ? {
              team_governance: {
                ...recomposed.team_governance,
                lifecycle: {
                  ...recomposed.team_governance.lifecycle,
                  max_members: Math.max(
                    recomposed.team_governance.lifecycle.max_members,
                    recomposed.assignments.length + carriedRestaffed.length
                  ),
                },
                composition: {
                  ...recomposed.team_governance.composition,
                  required_roles: [
                    ...recomposed.team_governance.composition.required_roles,
                    ...carriedRestaffed.map((assignment) => assignment.team_role),
                  ],
                  assigned_roles: [...recomposed.assignments, ...carriedRestaffed]
                    .filter((assignment) => assignment.status === 'assigned')
                    .map((assignment) => assignment.team_role),
                  standby_roles: [...recomposed.assignments, ...carriedRestaffed]
                    .filter((assignment) => assignment.status === 'standby')
                    .map((assignment) => assignment.team_role),
                },
              },
            }
          : {}),
      }
    : recomposed;

  const previouslyStaffedRoles = previousPlan.assignments
    .filter((assignment) => assignment.status === 'assigned')
    .map((assignment) => assignment.team_role);
  return previouslyStaffedRoles.length > 0
    ? promoteMissionTeamPlanRoles(withRestaffed, previouslyStaffedRoles).plan
    : withRestaffed;
}

export interface MissionTeamRoleGap {
  team_role: string;
  kind: 'none' | 'role_not_on_roster' | 'role_unfilled' | 'no_capable_actor';
  /** Required capabilities no eligible actor holds. */
  missing_capabilities: string[];
  /** Actors eligible for the role once exclusions are applied. */
  eligible_agent_ids: string[];
}

/**
 * TC-07: name the reason a role cannot take a task.
 *
 * Dispatch used to collapse every staffing failure into
 * `blocked(unassigned_role)` with the advice "assign an agent for role X",
 * which is the same message whether the role is simply missing from the
 * roster (restaffable — TC-06) or whether no actor in the pool holds the
 * capabilities the task needs (a real pool gap a human must close). This
 * distinguishes them so the caller can act instead of escalating blindly.
 */
export function diagnoseMissionTeamRoleGap(input: {
  missionId: string;
  teamRole: string;
  requiredCapabilities?: string[];
  excludedAgentIds?: string[];
}): MissionTeamRoleGap {
  const teamRole = input.teamRole;
  const requiredCapabilities = Array.from(
    new Set(
      (input.requiredCapabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    )
  );
  const excludedAgentIds = new Set(
    (input.excludedAgentIds || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  );
  const base: MissionTeamRoleGap = {
    team_role: teamRole,
    kind: 'none',
    missing_capabilities: [],
    eligible_agent_ids: [],
  };

  const plan = loadMissionTeamPlan(input.missionId.toUpperCase());
  const assignment = plan ? getMissionTeamAssignment(plan, teamRole) : null;
  if (!assignment) {
    return { ...base, kind: 'role_not_on_roster' };
  }

  const agents = loadAgentProfileIndex();
  const eligible = Object.entries(agents).filter(
    ([agentId, profile]) =>
      profile.team_roles.includes(teamRole) && !excludedAgentIds.has(agentId.toLowerCase())
  );
  const eligibleAgentIds = eligible.map(([agentId]) => agentId).sort();
  if (eligible.length === 0) {
    return {
      ...base,
      kind: assignment.status === 'unfilled' ? 'role_unfilled' : 'no_capable_actor',
      missing_capabilities: requiredCapabilities,
      eligible_agent_ids: [],
    };
  }

  const missingCapabilities = requiredCapabilities.filter(
    (capability) =>
      !eligible.some(([, profile]) =>
        (profile.capabilities || []).some((entry) => entry.trim().toLowerCase() === capability)
      )
  );
  if (assignment.status === 'unfilled') {
    return {
      ...base,
      kind: 'role_unfilled',
      missing_capabilities: missingCapabilities,
      eligible_agent_ids: eligibleAgentIds,
    };
  }
  if (missingCapabilities.length > 0) {
    return {
      ...base,
      kind: 'no_capable_actor',
      missing_capabilities: missingCapabilities,
      eligible_agent_ids: eligibleAgentIds,
    };
  }
  return { ...base, eligible_agent_ids: eligibleAgentIds };
}

export type ExtendMissionTeamRosterRefusal =
  'already_on_roster' | 'unknown_team_role' | 'max_members_reached' | 'no_compatible_actor';

export interface ExtendMissionTeamRosterResult {
  plan: MissionTeamPlan;
  added: MissionTeamAssignment | null;
  refusal?: ExtendMissionTeamRosterRefusal;
}

/**
 * TC-06: add a role the roster does not have, mid-mission.
 *
 * Composition derives the roster from the template and the obligations that
 * match at creation time. Real work sometimes demands a role neither of them
 * anticipated — a review that needs an independent actor the roster cannot
 * supply, a task whose capabilities nobody on the team holds. Before this
 * existed the only outcome was a blocked task and a note asking a human to
 * "assign an agent".
 *
 * Restaffing is bounded rather than free-form: it refuses past the lifecycle
 * `max_members` cap, it runs the same capability/authority/scope-class match
 * as initial composition, and it applies the same separation-of-duties
 * constraints against the roles the plan has already filled. A restaffed
 * member is marked `role_sources: ['restaff']`, so an audit can tell a
 * derived member from a planned one.
 */
export function extendMissionTeamPlanRoster(
  plan: MissionTeamPlan,
  input: {
    teamRole: string;
    requiredCapabilities?: string[];
    excludeAgentIds?: string[];
  }
): ExtendMissionTeamRosterResult {
  const teamRole = input.teamRole.trim();
  if (plan.assignments.some((assignment) => assignment.team_role === teamRole)) {
    return { plan, added: null, refusal: 'already_on_roster' };
  }

  const maxMembers = plan.team_governance?.lifecycle.max_members;
  if (typeof maxMembers === 'number' && plan.assignments.length >= maxMembers) {
    return { plan, added: null, refusal: 'max_members_reached' };
  }

  const roleRecord = loadTeamRoleIndex()[teamRole];
  if (!roleRecord) {
    return { plan, added: null, refusal: 'unknown_team_role' };
  }

  const holders = new Map<string, RoleHolder>();
  for (const assignment of plan.assignments) {
    if (assignment.status === 'unfilled') continue;
    holders.set(assignment.team_role, {
      agentId: assignment.agent_id,
      provider: assignment.provider,
    });
  }
  const separation = resolveRoleSeparation(teamRole, holders);
  const excludeAgents = [...(separation?.excludeAgents || []), ...(input.excludeAgentIds || [])];

  const requiredCapabilities = Array.from(
    new Set([...(roleRecord.required_capabilities || []), ...(input.requiredCapabilities || [])])
  );
  const selected = selectAgentForTeamRole({
    teamRole,
    teamRoleRecord: { ...roleRecord, required_capabilities: requiredCapabilities },
    authorityRoles: loadAuthorityRoleIndex(),
    agents: loadAgentProfileIndex(),
    // The mission-level routing hint is shared by every member, so carry it
    // over instead of re-deriving it from a classification that has moved on.
    routingHint: plan.assignments.find((assignment) => assignment.model_hint)?.model_hint,
    separation: { ...(separation || {}), excludeAgents },
    organizationId: plan.organization_profile?.organization_id,
    loadIndex: collectWorkforceLoad(),
  });
  if (selected.status !== 'assigned' || !selected.agent_id) {
    return { plan, added: null, refusal: 'no_compatible_actor' };
  }
  // `selectAgentForTeamRole` falls back to an excluded actor rather than
  // leaving a role unstaffed. That trade is right at composition time; it is
  // wrong here, because a caller restaffs precisely BECAUSE the excluded
  // actors are disqualified (an implementer cannot review their own work).
  // Capability shortfalls are likewise scored, not enforced, so both are
  // hard-checked before the member joins the roster.
  const excludedAgentIds = new Set(
    excludeAgents
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => entry.toLowerCase())
  );
  if (excludedAgentIds.has(selected.agent_id.toLowerCase())) {
    return { plan, added: null, refusal: 'no_compatible_actor' };
  }
  const selectedCapabilities = new Set(
    (loadAgentProfileIndex()[selected.agent_id]?.capabilities || []).map((entry) =>
      entry.trim().toLowerCase()
    )
  );
  const missingCapability = requiredCapabilities
    .map((entry) => entry.trim().toLowerCase())
    .find((capability) => capability && !selectedCapabilities.has(capability));
  if (missingCapability) {
    return { plan, added: null, refusal: 'no_compatible_actor' };
  }

  const added = enrichAssignmentContext({
    assignment: {
      ...selected,
      required: true,
      role_sources: ['restaff'],
      model_hint: plan.assignments.find((assignment) => assignment.model_hint)?.model_hint,
    },
    missionId: plan.mission_id,
    tier: plan.tier as 'personal' | 'confidential' | 'public',
    tenantId: plan.tenant_slug || 'default',
    risk: plan.mission_classification?.risk_profile || 'low',
  });

  const assignments = [...plan.assignments, added];
  const team_governance = plan.team_governance
    ? {
        ...plan.team_governance,
        composition: {
          ...plan.team_governance.composition,
          required_roles: [...plan.team_governance.composition.required_roles, teamRole],
          assigned_roles: assignments
            .filter((assignment) => assignment.status === 'assigned')
            .map((assignment) => assignment.team_role),
          standby_roles: assignments
            .filter((assignment) => assignment.status === 'standby')
            .map((assignment) => assignment.team_role),
        },
      }
    : undefined;

  return {
    plan: {
      ...plan,
      assignments,
      ...(team_governance ? { team_governance } : {}),
    },
    added,
  };
}

/**
 * TC-02: promote standby roles to staffed, in place, without re-running
 * selection. The candidate actor, authority role, delegation contract and
 * security scope were all resolved at composition time, so a promotion is a
 * pure state transition over the recorded plan — the same mission always
 * promotes the same actor for the same role.
 *
 * Roles that are `unfilled` (no compatible actor in the pool) are not
 * promotable and are reported by the caller as gaps.
 */
export function promoteMissionTeamPlanRoles(
  plan: MissionTeamPlan,
  teamRoles: string[]
): { plan: MissionTeamPlan; promoted: string[] } {
  const requestedRoles = new Set(teamRoles);
  const promoted: string[] = [];
  const assignments = plan.assignments.map((assignment) => {
    if (
      assignment.status !== 'standby' ||
      !requestedRoles.has(assignment.team_role) ||
      !assignment.agent_id
    ) {
      return assignment;
    }
    promoted.push(assignment.team_role);
    return { ...assignment, status: 'assigned' as const };
  });
  if (promoted.length === 0) return { plan, promoted };

  const team_governance = plan.team_governance
    ? {
        ...plan.team_governance,
        composition: {
          ...plan.team_governance.composition,
          assigned_roles: assignments
            .filter((entry) => entry.status === 'assigned')
            .map((entry) => entry.team_role),
          standby_roles: assignments
            .filter((entry) => entry.status === 'standby')
            .map((entry) => entry.team_role),
        },
      }
    : undefined;

  return {
    plan: {
      ...plan,
      assignments,
      ...(team_governance ? { team_governance } : {}),
    },
    promoted,
  };
}

export function getMissionTeamAssignment(
  plan: MissionTeamPlan,
  teamRole: string
): MissionTeamAssignment | null {
  return plan.assignments.find((entry) => entry.team_role === teamRole) || null;
}

export function resolveMissionTeamReceiver(input: {
  missionId: string;
  teamRole: string;
  excludedAgentIds?: string[];
  requiredCapabilities?: string[];
}): MissionTeamAssignment | null {
  const plan = loadMissionTeamPlan(input.missionId);
  if (!plan) return null;
  const assignment = getMissionTeamAssignment(plan, input.teamRole);
  // TC-01: resolving "who holds this role" is a read of the roster, not a
  // staffing act. A standby role already has its candidate resolved, so
  // readers (dispatch routing, review independence, context packs) keep
  // working; staffing stays a separate governed step
  // (`staffMissionTeamRoles`).
  if (!assignment || assignment.status === 'unfilled' || !assignment.agent_id) return null;
  const excludedAgentIds = new Set(
    (input.excludedAgentIds || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  );
  const requiredCapabilities = Array.from(
    new Set(
      (input.requiredCapabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    )
  );
  if (excludedAgentIds.size === 0 && requiredCapabilities.length === 0) return assignment;

  const agents = loadAgentProfileIndex();
  const currentProfile = agents[assignment.agent_id];
  const currentCapabilities = new Set(
    (currentProfile?.capabilities || []).map((entry) => entry.trim().toLowerCase())
  );
  if (
    !excludedAgentIds.has(assignment.agent_id.toLowerCase()) &&
    requiredCapabilities.every((capability) => currentCapabilities.has(capability))
  ) {
    return assignment;
  }

  const roleRecord = loadTeamRoleIndex()[input.teamRole];
  if (!roleRecord) return null;
  const eligibleAgents = Object.fromEntries(
    Object.entries(agents).filter(([agentId]) => !excludedAgentIds.has(agentId.toLowerCase()))
  );
  const selected = selectAgentForTeamRole({
    teamRole: input.teamRole,
    teamRoleRecord: {
      ...roleRecord,
      required_capabilities: Array.from(
        new Set([...(roleRecord.required_capabilities || []), ...requiredCapabilities])
      ),
    },
    authorityRoles: loadAuthorityRoleIndex(),
    agents: eligibleAgents,
    routingHint: assignment.model_hint,
    loadIndex: collectWorkforceLoad(),
  });
  if (selected.status !== 'assigned' || !selected.agent_id) return null;
  const selectedCapabilities = new Set(
    (eligibleAgents[selected.agent_id]?.capabilities || []).map((entry) =>
      entry.trim().toLowerCase()
    )
  );
  if (!requiredCapabilities.every((capability) => selectedCapabilities.has(capability))) {
    return null;
  }
  return enrichAssignmentContext({
    assignment: {
      ...selected,
      model_hint: assignment.model_hint,
    },
    missionId: plan.mission_id,
    tier: plan.tier as 'personal' | 'confidential' | 'public',
    tenantId: plan.tenant_slug || 'default',
    risk: plan.mission_classification?.risk_profile || 'low',
  });
}

export type {
  AuthorityRoleRecord,
  AgentProfileRecord,
  MissionTeamAssignment,
  TeamRoleRecord,
} from './team-role-assignment-selection.js';

export function buildMissionTeamView(plan: MissionTeamPlan): Record<string, string> {
  const view: Record<string, string> = {};
  for (const assignment of plan.assignments) {
    // The view is the roster (who holds each role), not the staffed subset.
    if (assignment.status !== 'unfilled' && assignment.agent_id) {
      view[assignment.team_role] = assignment.agent_id;
    }
  }
  return view;
}
