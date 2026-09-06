import { isRecord } from '@agent/core/foundation/primitives';
import type { IntelligencePayload } from '../components/MissionIntelligenceTypes';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACCESS_ROLES = new Set(['readonly', 'localadmin']);
const MISSION_TONES = new Set(['planning', 'ready', 'attention', 'pending']);
const PROJECT_STATUSES = new Set(['draft', 'active', 'paused', 'archived']);
const PROJECT_TIERS = new Set(['personal', 'confidential', 'public']);
const TRACK_STATUSES = new Set(['planned', 'active', 'paused', 'completed', 'archived']);
const TRACK_TYPES = new Set([
  'delivery',
  'change',
  'release',
  'incident',
  'compliance',
  'operations',
  'research',
]);
const TRACK_LIFECYCLES = new Set([
  'sdlc',
  'continuous_delivery',
  'incident_response',
  'continuous_operations',
  'research_cycle',
]);
const SEED_STATUSES = new Set(['proposed', 'ready', 'promoted', 'archived']);
const DISTILL_SOURCE_TYPES = new Set(['task_session', 'mission', 'artifact']);
const DISTILL_STATUSES = new Set(['proposed', 'promoted', 'archived']);
const DISTILL_TARGET_KINDS = new Set([
  'pattern',
  'sop_candidate',
  'knowledge_hint',
  'report_template',
]);
const APPROVAL_KINDS = new Set(['channel-approval', 'secret_mutation', 'mission_gate']);
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const SURFACE_TONES = new Set(['stable', 'attention', 'offline', 'pending']);
const MESSAGE_TYPES = new Set(['handoff', 'prompt', 'agent', 'stderr']);
const MESSAGE_TONES = new Set(['request', 'response', 'runtime']);
const CONTROL_KINDS = new Set(['mission', 'surface']);
const CONTROL_STATUSES = new Set(['queued', 'completed', 'failed']);
const ASSET_CATEGORIES = new Set(['deliverables', 'artifacts', 'outputs', 'evidence']);
const STORAGE_CLASSES = new Set(['repo', 'artifact_store', 'vault', 'tmp', 'external_ref']);
const TOPOLOGY_FLOW_KINDS = new Set(['a2a', 'agent_message', 'surface_link']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || stringArray(value);
}

function optionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || nonNegativeInteger(value);
}

function optionalRecord(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isRecord(value);
}

function parseArray<T>(value: unknown, parser: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(parser);
  return entries.every((entry): entry is T => entry !== undefined) ? entries : undefined;
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function isWorkLoop(value: unknown): boolean {
  return isRecord(value);
}

function parseMission(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.missionId) &&
    nonEmptyString(value.status) &&
    nonEmptyString(value.tier) &&
    optionalString(value.missionType) &&
    optionalString(value.projectId) &&
    optionalString(value.projectPath) &&
    optionalString(value.trackId) &&
    optionalString(value.trackName) &&
    typeof value.planReady === 'boolean' &&
    nonNegativeInteger(value.nextTaskCount) &&
    nonEmptyString(value.controlSummary) &&
    typeof value.controlTone === 'string' &&
    MISSION_TONES.has(value.controlTone) &&
    optionalString(value.controlRequestedBy)
  );
}

function parseProject(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.project_id) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.summary) ||
    typeof value.status !== 'string' ||
    !PROJECT_STATUSES.has(value.status) ||
    typeof value.tier !== 'string' ||
    !PROJECT_TIERS.has(value.tier) ||
    !optionalString(value.primary_locale) ||
    !optionalStringArray(value.service_bindings) ||
    !optionalStringArray(value.active_missions) ||
    !optionalString(value.kickoff_task_session_id)
  ) {
    return false;
  }
  if (value.bootstrap_work_items === undefined) return true;
  return Boolean(
    parseArray(value.bootstrap_work_items, (entry) =>
      isRecord(entry) &&
      nonEmptyString(entry.work_id) &&
      (entry.kind === 'mission_seed' || entry.kind === 'task_session') &&
      nonEmptyString(entry.title) &&
      nonEmptyString(entry.summary) &&
      (entry.status === 'planned' || entry.status === 'active' || entry.status === 'completed') &&
      nonEmptyString(entry.specialist_id) &&
      optionalString(entry.outcome_id)
        ? entry
        : undefined
    )
  );
}

function parseProjectTrack(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.track_id) ||
    !nonEmptyString(value.project_id) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.summary) ||
    typeof value.status !== 'string' ||
    !TRACK_STATUSES.has(value.status) ||
    typeof value.track_type !== 'string' ||
    !TRACK_TYPES.has(value.track_type) ||
    typeof value.lifecycle_model !== 'string' ||
    !TRACK_LIFECYCLES.has(value.lifecycle_model) ||
    typeof value.tier !== 'string' ||
    !PROJECT_TIERS.has(value.tier) ||
    !optionalString(value.primary_locale) ||
    !optionalString(value.release_id) ||
    !optionalString(value.change_scope) ||
    !optionalString(value.gate_profile_id) ||
    !optionalStringArray(value.active_missions) ||
    !optionalStringArray(value.required_artifacts) ||
    !optionalRecord(value.gate_readiness)
  ) {
    return false;
  }
  if (!value.gate_readiness) return true;
  return parseGateReadiness(value.gate_readiness);
}

function parseGateReadiness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (Object.prototype.hasOwnProperty.call(value, 'track_id') && !nonEmptyString(value.track_id)) ||
    !nonNegativeInteger(value.ready_gate_count) ||
    !nonNegativeInteger(value.total_gate_count) ||
    !optionalString(value.current_gate_id) ||
    !optionalString(value.current_phase) ||
    typeof value.ready !== 'boolean'
  ) {
    return false;
  }
  if (value.next_required_artifacts === undefined) return true;
  return Boolean(
    parseArray(value.next_required_artifacts, (entry) =>
      isRecord(entry) && nonEmptyString(entry.artifact_id) && optionalString(entry.template_ref)
        ? entry
        : undefined
    )
  );
}

function parseProjectManagement(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.project) ||
    !nonEmptyString(value.project.project_id) ||
    !nonEmptyString(value.project.name) ||
    !isRecord(value.lineage) ||
    !isRecordArray(value.lineage.tracks) ||
    !isRecordArray(value.lineage.tasks) ||
    !isRecordArray(value.lineage.missions) ||
    !isRecordArray(value.lineage.task_sessions) ||
    !isRecordArray(value.lineage.pipelines) ||
    !isRecord(value.lineage.role_explanations)
  ) {
    return false;
  }
  const explanations = value.lineage.role_explanations;
  return (
    ['project', 'track', 'mission', 'task', 'task_session', 'pipeline'].every((key) =>
      nonEmptyString(explanations[key])
    ) &&
    value.lineage.tracks.every(
      (track) =>
        nonEmptyString(track.track_id) && nonEmptyString(track.name) && nonEmptyString(track.status)
    ) &&
    value.lineage.tasks.every(
      (task) =>
        nonEmptyString(task.work_id) && nonEmptyString(task.title) && nonEmptyString(task.status)
    ) &&
    value.lineage.missions.every(
      (mission) =>
        nonEmptyString(mission.mission_id) &&
        nonEmptyString(mission.status) &&
        optionalString(mission.track_id)
    ) &&
    value.lineage.task_sessions.every(
      (session) => nonEmptyString(session.session_id) && nonEmptyString(session.status)
    ) &&
    value.lineage.pipelines.every((pipeline) => nonEmptyString(pipeline.pipeline_id))
  );
}

function parseMissionSeed(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.seed_id) &&
    nonEmptyString(value.project_id) &&
    optionalString(value.track_id) &&
    optionalString(value.track_name) &&
    optionalString(value.source_task_session_id) &&
    optionalString(value.source_work_id) &&
    nonEmptyString(value.title) &&
    nonEmptyString(value.summary) &&
    typeof value.status === 'string' &&
    SEED_STATUSES.has(value.status) &&
    nonEmptyString(value.specialist_id) &&
    optionalString(value.outcome_id) &&
    optionalString(value.mission_type_hint) &&
    optionalString(value.locale) &&
    optionalRecord(value.metadata) &&
    optionalString(value.promoted_mission_id) &&
    (value.work_loop === undefined || isWorkLoop(value.work_loop))
  );
}

function parseDistillCandidate(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.candidate_id) &&
    typeof value.source_type === 'string' &&
    DISTILL_SOURCE_TYPES.has(value.source_type) &&
    (value.tier === undefined ||
      (typeof value.tier === 'string' && PROJECT_TIERS.has(value.tier))) &&
    optionalString(value.project_id) &&
    optionalString(value.track_id) &&
    optionalString(value.track_name) &&
    optionalString(value.mission_id) &&
    optionalString(value.task_session_id) &&
    optionalStringArray(value.artifact_ids) &&
    nonEmptyString(value.title) &&
    nonEmptyString(value.summary) &&
    typeof value.status === 'string' &&
    DISTILL_STATUSES.has(value.status) &&
    typeof value.target_kind === 'string' &&
    DISTILL_TARGET_KINDS.has(value.target_kind) &&
    optionalString(value.specialist_id) &&
    optionalString(value.locale) &&
    optionalString(value.promoted_ref) &&
    optionalStringArray(value.evidence_refs) &&
    (value.work_loop === undefined || isWorkLoop(value.work_loop))
  );
}

function parseServiceBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.binding_id) &&
    nonEmptyString(value.service_type) &&
    nonEmptyString(value.scope) &&
    nonEmptyString(value.target) &&
    stringArray(value.allowed_actions) &&
    (value.auth_mode === undefined ||
      ['none', 'secret-guard', 'session'].includes(value.auth_mode as string)) &&
    optionalRecord(value.metadata)
  );
}

function parseArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.artifact_id) &&
    optionalString(value.project_id) &&
    optionalString(value.track_id) &&
    optionalString(value.track_name) &&
    optionalString(value.mission_id) &&
    optionalString(value.task_session_id) &&
    nonEmptyString(value.kind) &&
    typeof value.storage_class === 'string' &&
    STORAGE_CLASSES.has(value.storage_class) &&
    optionalString(value.path) &&
    optionalString(value.external_ref) &&
    optionalString(value.preview_text) &&
    (value.work_loop === undefined || isWorkLoop(value.work_loop))
  );
}

function parseApproval(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    typeof value.kind === 'string' &&
    APPROVAL_KINDS.has(value.kind) &&
    nonEmptyString(value.channel) &&
    nonEmptyString(value.storageChannel) &&
    nonEmptyString(value.requestedAt) &&
    nonEmptyString(value.requestedBy) &&
    nonEmptyString(value.title) &&
    nonEmptyString(value.summary) &&
    typeof value.riskLevel === 'string' &&
    RISK_LEVELS.has(value.riskLevel) &&
    stringArray(value.pendingRoles) &&
    optionalString(value.missionId) &&
    optionalString(value.trackId) &&
    optionalString(value.serviceId) &&
    (value.work_loop === undefined || isWorkLoop(value.work_loop))
  );
}

function parseSurface(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.kind) &&
    optionalString(value.startupMode) &&
    typeof value.enabled === 'boolean' &&
    typeof value.running === 'boolean' &&
    optionalNonNegativeInteger(value.pid) &&
    nonEmptyString(value.health) &&
    optionalString(value.detail) &&
    nonEmptyString(value.controlSummary) &&
    typeof value.controlTone === 'string' &&
    SURFACE_TONES.has(value.controlTone) &&
    optionalString(value.controlRequestedBy)
  );
}

function parseEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.ts) &&
    nonEmptyString(value.decision) &&
    optionalString(value.mission_id) &&
    optionalString(value.why)
  );
}

function parseAgentMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.ts) &&
    optionalString(value.missionId) &&
    nonEmptyString(value.agentId) &&
    optionalString(value.teamRole) &&
    nonEmptyString(value.ownerId) &&
    nonEmptyString(value.ownerType) &&
    optionalString(value.channel) &&
    optionalString(value.thread) &&
    typeof value.type === 'string' &&
    MESSAGE_TYPES.has(value.type) &&
    typeof value.tone === 'string' &&
    MESSAGE_TONES.has(value.tone) &&
    nonEmptyString(value.content)
  );
}

function parseHandoff(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.ts) &&
    nonEmptyString(value.missionId) &&
    nonEmptyString(value.sender) &&
    nonEmptyString(value.receiver) &&
    optionalString(value.teamRole) &&
    optionalString(value.channel) &&
    optionalString(value.thread) &&
    optionalString(value.performative) &&
    optionalString(value.intent) &&
    optionalString(value.promptExcerpt)
  );
}

function parseControlAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    optionalString(value.event_id) &&
    nonEmptyString(value.ts) &&
    typeof value.kind === 'string' &&
    CONTROL_KINDS.has(value.kind) &&
    nonEmptyString(value.target) &&
    nonEmptyString(value.operation) &&
    typeof value.status === 'string' &&
    CONTROL_STATUSES.has(value.status) &&
    nonEmptyString(value.requested_by) &&
    optionalString(value.error)
  );
}

function parseOwnerSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.ts) &&
    nonEmptyString(value.mission_id) &&
    nonNegativeInteger(value.accepted_count) &&
    nonNegativeInteger(value.reviewed_count) &&
    nonNegativeInteger(value.completed_count) &&
    nonNegativeInteger(value.requested_count)
  );
}

function parseMissionProgress(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.missionId) ||
    !isRecordArray(value.generatedAssets)
  ) {
    return false;
  }
  return value.generatedAssets.every(
    (asset) =>
      nonEmptyString(asset.path) &&
      typeof asset.category === 'string' &&
      ASSET_CATEGORIES.has(asset.category) &&
      nonNegativeInteger(asset.sizeBytes) &&
      nonEmptyString(asset.updatedAt)
  );
}

function parseBrowserSession(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.session_id) ||
    !nonEmptyString(value.active_tab_id) ||
    !nonNegativeInteger(value.tab_count) ||
    !nonEmptyString(value.updated_at) ||
    !optionalString(value.last_trace_path) ||
    !optionalString(value.lease_expires_at) ||
    !['active', 'released', 'expired'].includes(value.lease_status as string) ||
    typeof value.retained !== 'boolean' ||
    !nonNegativeInteger(value.action_trail_count) ||
    !isRecordArray(value.recent_actions)
  ) {
    return false;
  }
  return value.recent_actions.every(
    (action) =>
      nonEmptyString(action.op) &&
      ['control', 'capture', 'apply'].includes(action.kind as string) &&
      optionalString(action.tab_id) &&
      optionalString(action.ref) &&
      optionalString(action.selector) &&
      nonEmptyString(action.ts)
  );
}

function parseBrowserConversationSession(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.session_id) &&
    nonEmptyString(value.surface) &&
    nonEmptyString(value.status) &&
    nonEmptyString(value.mode) &&
    nonEmptyString(value.updated_at) &&
    nonEmptyString(value.goal_summary) &&
    optionalString(value.active_step) &&
    typeof value.pending_confirmation === 'boolean' &&
    nonNegativeInteger(value.candidate_target_count)
  );
}

function parseRuntimeLease(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.agent_id) &&
    nonEmptyString(value.owner_id) &&
    nonEmptyString(value.owner_type) &&
    optionalRecord(value.metadata)
  );
}

function parseRuntimeDoctor(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.severity === 'warning' || value.severity === 'critical') &&
    nonEmptyString(value.agentId) &&
    nonEmptyString(value.ownerId) &&
    nonEmptyString(value.reason) &&
    (value.recommendedAction === 'stop_runtime' || value.recommendedAction === 'restart_runtime')
  );
}

function parseTopology(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecordArray(value.surfaces) ||
    !isRecordArray(value.owners) ||
    !isRecordArray(value.runtimes) ||
    !isRecordArray(value.flows)
  ) {
    return false;
  }
  return (
    value.surfaces.every(
      (surface) =>
        nonEmptyString(surface.id) &&
        nonEmptyString(surface.kind) &&
        typeof surface.running === 'boolean' &&
        optionalString(surface.startupMode) &&
        optionalNonNegativeInteger(surface.pid)
    ) &&
    value.owners.every(
      (owner) =>
        nonEmptyString(owner.id) &&
        nonEmptyString(owner.type) &&
        nonNegativeInteger(owner.runtimeCount) &&
        stringArray(owner.runtimeIds)
    ) &&
    value.runtimes.every(
      (runtime) =>
        nonEmptyString(runtime.agentId) &&
        nonEmptyString(runtime.provider) &&
        optionalString(runtime.modelId) &&
        nonEmptyString(runtime.status) &&
        nonEmptyString(runtime.ownerId) &&
        nonEmptyString(runtime.ownerType) &&
        optionalString(runtime.requestedBy) &&
        optionalString(runtime.leaseKind) &&
        optionalNonNegativeInteger(runtime.pid) &&
        optionalRecord(runtime.metadata) &&
        nonNegativeInteger(runtime.recentActivityCount)
    ) &&
    value.flows.every(
      (flow) =>
        nonEmptyString(flow.id) &&
        nonEmptyString(flow.from) &&
        nonEmptyString(flow.to) &&
        nonNegativeInteger(flow.count) &&
        nonEmptyString(flow.latestAt) &&
        optionalString(flow.channel) &&
        optionalString(flow.thread) &&
        typeof flow.kind === 'string' &&
        TOPOLOGY_FLOW_KINDS.has(flow.kind)
    )
  );
}

function parseControlActionDefinition(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.operation) &&
    nonEmptyString(value.label) &&
    (value.risk === 'safe' || value.risk === 'risky') &&
    typeof value.approvalRequired === 'boolean' &&
    typeof value.enabled === 'boolean' &&
    optionalString(value.disabledReason)
  );
}

function parseActionDefinitionArray(value: unknown): boolean {
  return Boolean(
    parseArray(value, (entry) => (parseControlActionDefinition(entry) ? entry : undefined))
  );
}

function parseStringKeyedActionDefinitions(value: unknown): boolean {
  return (
    isRecord(value) && Object.values(value).every((entries) => parseActionDefinitionArray(entries))
  );
}

function parseControlCatalog(value: unknown): boolean {
  return (
    isRecord(value) &&
    parseActionDefinitionArray(value.mission) &&
    parseActionDefinitionArray(value.surface) &&
    parseActionDefinitionArray(value.globalSurface)
  );
}

function parseControlAvailability(value: unknown): boolean {
  return (
    isRecord(value) &&
    parseStringKeyedActionDefinitions(value.mission) &&
    parseStringKeyedActionDefinitions(value.surface) &&
    parseActionDefinitionArray(value.globalSurface)
  );
}

function parseControlDetails(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((entries) =>
      parseArray(entries, (entry) =>
        isRecord(entry) &&
        nonEmptyString(entry.ts) &&
        nonEmptyString(entry.decision) &&
        optionalString(entry.event_type) &&
        optionalString(entry.mission_id) &&
        optionalString(entry.resource_id) &&
        optionalString(entry.operation) &&
        optionalString(entry.action_id) &&
        optionalString(entry.outcome) &&
        optionalString(entry.why) &&
        optionalString(entry.error)
          ? entry
          : undefined
      )
    )
  );
}

export function parseMissionIntelligenceResponse(value: unknown): IntelligencePayload | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const collections = [
    parseArray(value.activeMissions, (entry) => (parseMission(entry) ? entry : undefined)),
    parseArray(value.projects, (entry) => (parseProject(entry) ? entry : undefined)),
    parseArray(value.projectTracks, (entry) => (parseProjectTrack(entry) ? entry : undefined)),
    parseArray(value.missionSeeds, (entry) => (parseMissionSeed(entry) ? entry : undefined)),
    parseArray(value.distillCandidates, (entry) =>
      parseDistillCandidate(entry) ? entry : undefined
    ),
    parseArray(value.serviceBindings, (entry) => (parseServiceBinding(entry) ? entry : undefined)),
    parseArray(value.recentArtifacts, (entry) => (parseArtifact(entry) ? entry : undefined)),
    parseArray(value.pendingApprovals, (entry) => (parseApproval(entry) ? entry : undefined)),
    parseArray(value.surfaces, (entry) => (parseSurface(entry) ? entry : undefined)),
    parseArray(value.recentEvents, (entry) => (parseEvent(entry) ? entry : undefined)),
    parseArray(value.agentMessages, (entry) => (parseAgentMessage(entry) ? entry : undefined)),
    parseArray(value.a2aHandoffs, (entry) => (parseHandoff(entry) ? entry : undefined)),
    parseArray(value.controlActions, (entry) => (parseControlAction(entry) ? entry : undefined)),
    parseArray(value.ownerSummaries, (entry) => (parseOwnerSummary(entry) ? entry : undefined)),
    parseArray(value.missionProgress, (entry) => (parseMissionProgress(entry) ? entry : undefined)),
    parseArray(value.browserSessions, (entry) => (parseBrowserSession(entry) ? entry : undefined)),
    parseArray(value.browserConversationSessions, (entry) =>
      parseBrowserConversationSession(entry) ? entry : undefined
    ),
    parseArray(value.recentSurfaceOutbox, (entry) =>
      isRecord(entry) &&
      nonEmptyString(entry.message_id) &&
      (entry.surface === 'slack' || entry.surface === 'chronos') &&
      nonEmptyString(entry.correlation_id) &&
      nonEmptyString(entry.channel) &&
      nonEmptyString(entry.thread_ts) &&
      nonEmptyString(entry.text) &&
      (entry.source === 'surface' || entry.source === 'nerve' || entry.source === 'system') &&
      nonEmptyString(entry.created_at)
        ? entry
        : undefined
    ),
    parseArray(value.runtimeLeases, (entry) => (parseRuntimeLease(entry) ? entry : undefined)),
    parseArray(value.runtimeDoctor, (entry) => (parseRuntimeDoctor(entry) ? entry : undefined)),
  ];
  if (
    !nonNegativeInteger(value.revision) ||
    typeof value.accessRole !== 'string' ||
    !ACCESS_ROLES.has(value.accessRole) ||
    collections.some((collection) => collection === undefined) ||
    !parseControlCatalog(value.controlActionCatalog) ||
    !parseControlAvailability(value.controlActionAvailability) ||
    !parseControlDetails(value.controlActionDetails) ||
    !isRecord(value.surfaceOutbox) ||
    !nonNegativeInteger(value.surfaceOutbox.slack) ||
    !nonNegativeInteger(value.surfaceOutbox.chronos) ||
    !parseTopology(value.runtimeTopology) ||
    !isRecord(value.runtime) ||
    !nonNegativeInteger(value.runtime.total) ||
    !nonNegativeInteger(value.runtime.ready) ||
    !nonNegativeInteger(value.runtime.busy) ||
    !nonNegativeInteger(value.runtime.error) ||
    !optionalRecord(value.company) ||
    (value.projectManagement !== undefined &&
      !Boolean(
        parseArray(value.projectManagement, (entry) =>
          parseProjectManagement(entry) ? entry : undefined
        )
      )) ||
    (value.gateReadiness !== undefined &&
      !Boolean(
        parseArray(value.gateReadiness, (entry) => (parseGateReadiness(entry) ? entry : undefined))
      )) ||
    (value.missionSeedAssessment !== undefined &&
      (!isRecord(value.missionSeedAssessment) ||
        !nonNegativeInteger(value.missionSeedAssessment.total) ||
        !nonNegativeInteger(value.missionSeedAssessment.eligible) ||
        !nonNegativeInteger(value.missionSeedAssessment.flagged) ||
        !nonNegativeInteger(value.missionSeedAssessment.unassessed) ||
        !nonNegativeInteger(value.missionSeedAssessment.promotable) ||
        !stringArray(value.missionSeedAssessment.flagged_seed_ids) ||
        !stringArray(value.missionSeedAssessment.eligible_seed_ids) ||
        !stringArray(value.missionSeedAssessment.promoted_seed_ids))) ||
    (value.memoryCandidates !== undefined &&
      !Boolean(
        parseArray(value.memoryCandidates, (entry) =>
          isRecord(entry) &&
          nonEmptyString(entry.candidate_id) &&
          ['queued', 'approved', 'rejected', 'promoted'].includes(entry.status as string) &&
          nonEmptyString(entry.proposed_memory_kind) &&
          typeof entry.sensitivity_tier === 'string' &&
          PROJECT_TIERS.has(entry.sensitivity_tier) &&
          nonEmptyString(entry.source_ref) &&
          stringArray(entry.evidence_refs) &&
          optionalString(entry.promoted_ref)
            ? entry
            : undefined
        )
      )) ||
    (value.nextActions !== undefined &&
      !Boolean(
        parseArray(value.nextActions, (entry) =>
          isRecord(entry) &&
          nonEmptyString(entry.action_id) &&
          [
            'request_clarification',
            'approve',
            'inspect_evidence',
            'retry_delivery',
            'promote_mission_seed',
            'resume_mission',
          ].includes(entry.next_action_type as string) &&
          nonEmptyString(entry.reason) &&
          ['low', 'medium', 'high'].includes(entry.risk as string) &&
          optionalString(entry.suggested_command) &&
          (entry.suggested_surface_action === undefined ||
            ['approvals', 'mission-seeds', 'memory-promotion-queue', 'next-actions'].includes(
              entry.suggested_surface_action as string
            )) &&
          typeof entry.approval_required === 'boolean'
            ? entry
            : undefined
        )
      ))
  ) {
    return undefined;
  }
  return value as IntelligencePayload;
}
