import { validateNextActionContract } from './next-action-contract.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';

export type ControlPlaneSurface = 'presence' | 'chronos';

export interface ControlPlaneListResponse<T> {
  ok?: boolean;
  items?: T[];
}

export interface ControlPlaneProjectRecord {
  project_id: string;
  name?: string;
  status?: string;
  tier?: string;
  primary_locale?: string;
  active_missions?: string[];
  service_bindings?: string[];
}

export interface ControlPlaneApprovalRecord {
  id: string;
  kind?: 'channel-approval' | 'secret_mutation' | 'mission_gate';
  channel?: string;
  storageChannel?: string;
  requestedAt?: string;
  requestedBy?: string;
  title?: string;
  summary?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  pendingRoles?: string[];
  missionId?: string;
  trackId?: string;
  serviceId?: string;
  status?: string;
  expected_outcome?: string;
}

export interface ControlPlaneDistillCandidateRecord {
  candidate_id: string;
  source_type: 'task_session' | 'mission' | 'artifact';
  tier?: 'personal' | 'confidential' | 'public';
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id?: string;
  task_session_id?: string;
  artifact_ids?: string[];
  title: string;
  summary: string;
  status: 'proposed' | 'promoted' | 'archived';
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  specialist_id?: string;
  locale?: string;
  promoted_ref?: string;
  evidence_refs?: string[];
}

export interface ControlPlaneMemoryCandidateRecord {
  candidate_id: string;
  status: 'queued' | 'approved' | 'rejected' | 'promoted';
  proposed_memory_kind: string;
  sensitivity_tier: 'public' | 'confidential' | 'personal';
  source_ref: string;
  evidence_refs: string[];
  promoted_ref?: string;
}

export interface ControlPlaneMissionSeedRecord {
  seed_id: string;
  title?: string;
  status?: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  specialist_id?: string;
  mission_type_hint?: string;
  promoted_mission_id?: string;
  metadata?: {
    template_ref?: string;
    skeleton_path?: string;
    mission_seed_assessment?: {
      eligible?: boolean;
      reason?: string;
      shouldPromote?: boolean;
    };
    execution_contract?: {
      recommended_action?: string;
      review_target?: string;
      repository_id?: string;
    };
  };
}

export interface ControlPlaneProjectTrackRecord {
  track_id: string;
  project_id?: string;
  name?: string;
  summary?: string;
  status?: string;
  track_type?: string;
  lifecycle_model?: string;
  gate_readiness?: {
    ready_gate_count?: number;
    total_gate_count?: number;
    current_gate_id?: string;
    current_phase?: string;
    ready?: boolean;
    next_required_artifacts?: Array<{
      artifact_id?: string;
      template_ref?: string;
    }>;
  };
}

export interface ControlPlaneOutcomeRecord {
  artifact_id: string;
  kind?: string;
  preview_text?: string;
  project_id?: string;
  storage_class?: string;
  promoted_refs?: string[];
}

export interface ControlPlaneTaskSessionRecord {
  session_id: string;
  status?: string;
  task_type?: string;
  goal?: { summary?: string };
  project_context?: { project_id?: string };
  artifact?: { preview_text?: string };
}

export interface ChronosOverviewRecord {
  accessRole?: string;
  projects?: ControlPlaneProjectRecord[];
  projectTracks?: ControlPlaneProjectTrackRecord[];
  gateReadiness?: Array<ControlPlaneProjectTrackRecord['gate_readiness'] & { track_id: string }>;
  missionSeeds?: ControlPlaneMissionSeedRecord[];
  missionSeedAssessment?: {
    total?: number;
    eligible?: number;
    flagged?: number;
    unassessed?: number;
    promotable?: number;
    flagged_seed_ids?: string[];
    eligible_seed_ids?: string[];
    promoted_seed_ids?: string[];
  };
  pendingApprovals?: ControlPlaneApprovalRecord[];
  distillCandidates?: ControlPlaneDistillCandidateRecord[];
  memoryCandidates?: ControlPlaneMemoryCandidateRecord[];
  nextActions?: Array<{
    action_id: string;
    next_action_type:
      | 'request_clarification'
      | 'approve'
      | 'inspect_evidence'
      | 'retry_delivery'
      | 'promote_mission_seed'
      | 'resume_mission';
    reason: string;
    risk: 'low' | 'medium' | 'high';
    suggested_command?: string;
    suggested_surface_action?:
      'approvals' | 'mission-seeds' | 'memory-promotion-queue' | 'next-actions';
    approval_required: boolean;
  }>;
}

export interface ControlPlaneErrorOptions {
  surface: ControlPlaneSurface;
  pathname: string;
  suggestedCommand?: string;
}

export class ControlPlaneClientError extends Error {
  surface: ControlPlaneSurface;
  pathname: string;
  suggestedCommand?: string;

  constructor(message: string, options: ControlPlaneErrorOptions) {
    super(message);
    this.name = 'ControlPlaneClientError';
    this.surface = options.surface;
    this.pathname = options.pathname;
    this.suggestedCommand = options.suggestedCommand;
  }
}

export interface ControlPlaneClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  retryCount?: number;
}

export interface ControlPlaneRemediationPlan {
  surface: ControlPlaneSurface;
  runtimeId: string;
  suggestedCommand: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalEnum<const T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeProjectRecord(value: unknown): ControlPlaneProjectRecord | null {
  if (!isRecord(value) || typeof value.project_id !== 'string' || !value.project_id) return null;
  return {
    project_id: value.project_id,
    ...(optionalString(value.name) !== undefined ? { name: optionalString(value.name) } : {}),
    ...(optionalString(value.status) !== undefined ? { status: optionalString(value.status) } : {}),
    ...(optionalString(value.tier) !== undefined ? { tier: optionalString(value.tier) } : {}),
    ...(optionalString(value.primary_locale) !== undefined
      ? { primary_locale: optionalString(value.primary_locale) }
      : {}),
    ...(stringArray(value.active_missions) !== undefined
      ? { active_missions: stringArray(value.active_missions) }
      : {}),
    ...(stringArray(value.service_bindings) !== undefined
      ? { service_bindings: stringArray(value.service_bindings) }
      : {}),
  };
}

function normalizeApprovalRecord(value: unknown): ControlPlaneApprovalRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  const kind = optionalEnum(value.kind, [
    'channel-approval',
    'secret_mutation',
    'mission_gate',
  ] as const);
  const riskLevel = optionalEnum(value.riskLevel, ['low', 'medium', 'high', 'critical'] as const);
  return {
    id: value.id,
    ...(kind !== undefined ? { kind } : {}),
    ...(optionalString(value.channel) !== undefined
      ? { channel: optionalString(value.channel) }
      : {}),
    ...(optionalString(value.storageChannel) !== undefined
      ? { storageChannel: optionalString(value.storageChannel) }
      : {}),
    ...(optionalString(value.requestedAt) !== undefined
      ? { requestedAt: optionalString(value.requestedAt) }
      : {}),
    ...(optionalString(value.requestedBy) !== undefined
      ? { requestedBy: optionalString(value.requestedBy) }
      : {}),
    ...(optionalString(value.title) !== undefined ? { title: optionalString(value.title) } : {}),
    ...(optionalString(value.summary) !== undefined
      ? { summary: optionalString(value.summary) }
      : {}),
    ...(riskLevel !== undefined ? { riskLevel } : {}),
    ...(stringArray(value.pendingRoles) !== undefined
      ? { pendingRoles: stringArray(value.pendingRoles) }
      : {}),
    ...(optionalString(value.missionId) !== undefined
      ? { missionId: optionalString(value.missionId) }
      : {}),
    ...(optionalString(value.trackId) !== undefined
      ? { trackId: optionalString(value.trackId) }
      : {}),
    ...(optionalString(value.serviceId) !== undefined
      ? { serviceId: optionalString(value.serviceId) }
      : {}),
    ...(optionalString(value.status) !== undefined ? { status: optionalString(value.status) } : {}),
    ...(optionalString(value.expected_outcome) !== undefined
      ? { expected_outcome: optionalString(value.expected_outcome) }
      : {}),
  };
}

function normalizeDistillCandidateRecord(
  value: unknown
): ControlPlaneDistillCandidateRecord | null {
  if (!isRecord(value)) return null;
  const sourceType = optionalEnum(value.source_type, [
    'task_session',
    'mission',
    'artifact',
  ] as const);
  const tier = optionalEnum(value.tier, ['personal', 'confidential', 'public'] as const);
  const status = optionalEnum(value.status, ['proposed', 'promoted', 'archived'] as const);
  const targetKind = optionalEnum(value.target_kind, [
    'pattern',
    'sop_candidate',
    'knowledge_hint',
    'report_template',
  ] as const);
  if (
    !nonEmptyString(value.candidate_id) ||
    sourceType === undefined ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.summary) ||
    status === undefined ||
    targetKind === undefined
  ) {
    return null;
  }
  return {
    candidate_id: value.candidate_id,
    source_type: sourceType,
    ...(tier !== undefined ? { tier } : {}),
    ...(optionalString(value.project_id) !== undefined
      ? { project_id: optionalString(value.project_id) }
      : {}),
    ...(optionalString(value.track_id) !== undefined
      ? { track_id: optionalString(value.track_id) }
      : {}),
    ...(optionalString(value.track_name) !== undefined
      ? { track_name: optionalString(value.track_name) }
      : {}),
    ...(optionalString(value.mission_id) !== undefined
      ? { mission_id: optionalString(value.mission_id) }
      : {}),
    ...(optionalString(value.task_session_id) !== undefined
      ? { task_session_id: optionalString(value.task_session_id) }
      : {}),
    ...(stringArray(value.artifact_ids) !== undefined
      ? { artifact_ids: stringArray(value.artifact_ids) }
      : {}),
    title: value.title,
    summary: value.summary,
    status,
    target_kind: targetKind,
    ...(optionalString(value.specialist_id) !== undefined
      ? { specialist_id: optionalString(value.specialist_id) }
      : {}),
    ...(optionalString(value.locale) !== undefined ? { locale: optionalString(value.locale) } : {}),
    ...(optionalString(value.promoted_ref) !== undefined
      ? { promoted_ref: optionalString(value.promoted_ref) }
      : {}),
    ...(stringArray(value.evidence_refs) !== undefined
      ? { evidence_refs: stringArray(value.evidence_refs) }
      : {}),
  };
}

function normalizeMemoryCandidateRecord(value: unknown): ControlPlaneMemoryCandidateRecord | null {
  if (!isRecord(value)) return null;
  const status = optionalEnum(value.status, [
    'queued',
    'approved',
    'rejected',
    'promoted',
  ] as const);
  const sensitivityTier = optionalEnum(value.sensitivity_tier, [
    'public',
    'confidential',
    'personal',
  ] as const);
  if (
    !nonEmptyString(value.candidate_id) ||
    status === undefined ||
    !nonEmptyString(value.proposed_memory_kind) ||
    sensitivityTier === undefined ||
    !nonEmptyString(value.source_ref) ||
    stringArray(value.evidence_refs) === undefined
  ) {
    return null;
  }
  return {
    candidate_id: value.candidate_id,
    status,
    proposed_memory_kind: value.proposed_memory_kind,
    sensitivity_tier: sensitivityTier,
    source_ref: value.source_ref,
    evidence_refs: stringArray(value.evidence_refs) as string[],
    ...(optionalString(value.promoted_ref) !== undefined
      ? { promoted_ref: optionalString(value.promoted_ref) }
      : {}),
  };
}

function normalizeMissionSeedMetadata(
  value: unknown
): ControlPlaneMissionSeedRecord['metadata'] | undefined {
  if (!isRecord(value)) return undefined;
  const assessment = isRecord(value.mission_seed_assessment)
    ? {
        ...(optionalBoolean(value.mission_seed_assessment.eligible) !== undefined
          ? { eligible: optionalBoolean(value.mission_seed_assessment.eligible) }
          : {}),
        ...(optionalString(value.mission_seed_assessment.reason) !== undefined
          ? { reason: optionalString(value.mission_seed_assessment.reason) }
          : {}),
        ...(optionalBoolean(value.mission_seed_assessment.shouldPromote) !== undefined
          ? { shouldPromote: optionalBoolean(value.mission_seed_assessment.shouldPromote) }
          : {}),
      }
    : undefined;
  const executionContract = isRecord(value.execution_contract)
    ? {
        ...(optionalString(value.execution_contract.recommended_action) !== undefined
          ? { recommended_action: optionalString(value.execution_contract.recommended_action) }
          : {}),
        ...(optionalString(value.execution_contract.review_target) !== undefined
          ? { review_target: optionalString(value.execution_contract.review_target) }
          : {}),
        ...(optionalString(value.execution_contract.repository_id) !== undefined
          ? { repository_id: optionalString(value.execution_contract.repository_id) }
          : {}),
      }
    : undefined;
  const metadata = {
    ...(optionalString(value.template_ref) !== undefined
      ? { template_ref: optionalString(value.template_ref) }
      : {}),
    ...(optionalString(value.skeleton_path) !== undefined
      ? { skeleton_path: optionalString(value.skeleton_path) }
      : {}),
    ...(assessment !== undefined ? { mission_seed_assessment: assessment } : {}),
    ...(executionContract !== undefined ? { execution_contract: executionContract } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeMissionSeedRecord(value: unknown): ControlPlaneMissionSeedRecord | null {
  if (!isRecord(value) || typeof value.seed_id !== 'string' || !value.seed_id) return null;
  const metadata = normalizeMissionSeedMetadata(value.metadata);
  return {
    seed_id: value.seed_id,
    ...(optionalString(value.title) !== undefined ? { title: optionalString(value.title) } : {}),
    ...(optionalString(value.status) !== undefined ? { status: optionalString(value.status) } : {}),
    ...(optionalString(value.project_id) !== undefined
      ? { project_id: optionalString(value.project_id) }
      : {}),
    ...(optionalString(value.track_id) !== undefined
      ? { track_id: optionalString(value.track_id) }
      : {}),
    ...(optionalString(value.track_name) !== undefined
      ? { track_name: optionalString(value.track_name) }
      : {}),
    ...(optionalString(value.specialist_id) !== undefined
      ? { specialist_id: optionalString(value.specialist_id) }
      : {}),
    ...(optionalString(value.mission_type_hint) !== undefined
      ? { mission_type_hint: optionalString(value.mission_type_hint) }
      : {}),
    ...(optionalString(value.promoted_mission_id) !== undefined
      ? { promoted_mission_id: optionalString(value.promoted_mission_id) }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function normalizeMissionSeedAssessment(
  value: unknown
): ChronosOverviewRecord['missionSeedAssessment'] | undefined {
  if (!isRecord(value)) return undefined;
  const flaggedSeedIds = stringArray(value.flagged_seed_ids);
  const eligibleSeedIds = stringArray(value.eligible_seed_ids);
  const promotedSeedIds = stringArray(value.promoted_seed_ids);
  const assessment = {
    ...(optionalFiniteNumber(value.total) !== undefined
      ? { total: optionalFiniteNumber(value.total) }
      : {}),
    ...(optionalFiniteNumber(value.eligible) !== undefined
      ? { eligible: optionalFiniteNumber(value.eligible) }
      : {}),
    ...(optionalFiniteNumber(value.flagged) !== undefined
      ? { flagged: optionalFiniteNumber(value.flagged) }
      : {}),
    ...(optionalFiniteNumber(value.unassessed) !== undefined
      ? { unassessed: optionalFiniteNumber(value.unassessed) }
      : {}),
    ...(optionalFiniteNumber(value.promotable) !== undefined
      ? { promotable: optionalFiniteNumber(value.promotable) }
      : {}),
    ...(flaggedSeedIds !== undefined ? { flagged_seed_ids: flaggedSeedIds } : {}),
    ...(eligibleSeedIds !== undefined ? { eligible_seed_ids: eligibleSeedIds } : {}),
    ...(promotedSeedIds !== undefined ? { promoted_seed_ids: promotedSeedIds } : {}),
  };
  return Object.keys(assessment).length > 0 ? assessment : undefined;
}

function normalizeGateReadiness(
  value: unknown
): ControlPlaneProjectTrackRecord['gate_readiness'] | null {
  if (!isRecord(value)) return null;
  const artifacts = Array.isArray(value.next_required_artifacts)
    ? value.next_required_artifacts.filter(isRecord).flatMap((artifact) => {
        const artifactId = optionalString(artifact.artifact_id);
        const templateRef = optionalString(artifact.template_ref);
        if (artifactId === undefined && templateRef === undefined) return [];
        return [
          {
            ...(artifactId !== undefined ? { artifact_id: artifactId } : {}),
            ...(templateRef !== undefined ? { template_ref: templateRef } : {}),
          },
        ];
      })
    : undefined;
  return {
    ...(optionalFiniteNumber(value.ready_gate_count) !== undefined
      ? { ready_gate_count: optionalFiniteNumber(value.ready_gate_count) }
      : {}),
    ...(optionalFiniteNumber(value.total_gate_count) !== undefined
      ? { total_gate_count: optionalFiniteNumber(value.total_gate_count) }
      : {}),
    ...(optionalString(value.current_gate_id) !== undefined
      ? { current_gate_id: optionalString(value.current_gate_id) }
      : {}),
    ...(optionalString(value.current_phase) !== undefined
      ? { current_phase: optionalString(value.current_phase) }
      : {}),
    ...(optionalBoolean(value.ready) !== undefined ? { ready: optionalBoolean(value.ready) } : {}),
    ...(artifacts !== undefined ? { next_required_artifacts: artifacts } : {}),
  };
}

function normalizeProjectTrackRecord(value: unknown): ControlPlaneProjectTrackRecord | null {
  if (!isRecord(value) || typeof value.track_id !== 'string' || !value.track_id) return null;
  const gateReadiness = normalizeGateReadiness(value.gate_readiness);
  return {
    track_id: value.track_id,
    ...(optionalString(value.project_id) !== undefined
      ? { project_id: optionalString(value.project_id) }
      : {}),
    ...(optionalString(value.name) !== undefined ? { name: optionalString(value.name) } : {}),
    ...(optionalString(value.summary) !== undefined
      ? { summary: optionalString(value.summary) }
      : {}),
    ...(optionalString(value.status) !== undefined ? { status: optionalString(value.status) } : {}),
    ...(optionalString(value.track_type) !== undefined
      ? { track_type: optionalString(value.track_type) }
      : {}),
    ...(optionalString(value.lifecycle_model) !== undefined
      ? { lifecycle_model: optionalString(value.lifecycle_model) }
      : {}),
    ...(gateReadiness !== null ? { gate_readiness: gateReadiness } : {}),
  };
}

function normalizeOutcomeRecord(value: unknown): ControlPlaneOutcomeRecord | null {
  if (!isRecord(value) || typeof value.artifact_id !== 'string' || !value.artifact_id) return null;
  return {
    artifact_id: value.artifact_id,
    ...(optionalString(value.kind) !== undefined ? { kind: optionalString(value.kind) } : {}),
    ...(optionalString(value.preview_text) !== undefined
      ? { preview_text: optionalString(value.preview_text) }
      : {}),
    ...(optionalString(value.project_id) !== undefined
      ? { project_id: optionalString(value.project_id) }
      : {}),
    ...(optionalString(value.storage_class) !== undefined
      ? { storage_class: optionalString(value.storage_class) }
      : {}),
    ...(stringArray(value.promoted_refs) !== undefined
      ? { promoted_refs: stringArray(value.promoted_refs) }
      : {}),
  };
}

function normalizeTaskSessionRecord(value: unknown): ControlPlaneTaskSessionRecord | null {
  if (!isRecord(value) || typeof value.session_id !== 'string' || !value.session_id) return null;
  const goal = isRecord(value.goal)
    ? {
        ...(optionalString(value.goal.summary) !== undefined
          ? { summary: optionalString(value.goal.summary) }
          : {}),
      }
    : undefined;
  const projectContext = isRecord(value.project_context)
    ? {
        ...(optionalString(value.project_context.project_id) !== undefined
          ? { project_id: optionalString(value.project_context.project_id) }
          : {}),
      }
    : undefined;
  const artifact = isRecord(value.artifact)
    ? {
        ...(optionalString(value.artifact.preview_text) !== undefined
          ? { preview_text: optionalString(value.artifact.preview_text) }
          : {}),
      }
    : undefined;
  return {
    session_id: value.session_id,
    ...(optionalString(value.status) !== undefined ? { status: optionalString(value.status) } : {}),
    ...(optionalString(value.task_type) !== undefined
      ? { task_type: optionalString(value.task_type) }
      : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(projectContext !== undefined ? { project_context: projectContext } : {}),
    ...(artifact !== undefined ? { artifact } : {}),
  };
}

const DEFAULT_BASE_URLS: Record<ControlPlaneSurface, string> = {
  presence: String(process.env.PRESENCE_STUDIO_URL || 'http://127.0.0.1:3031').replace(/\/$/, ''),
  chronos: String(process.env.CHRONOS_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
};

const DEFAULT_REMEDIATION_PLANS: Record<ControlPlaneSurface, ControlPlaneRemediationPlan> = {
  presence: {
    surface: 'presence',
    runtimeId: 'presence-studio',
    suggestedCommand: 'pnpm surfaces reconcile',
  },
  chronos: {
    surface: 'chronos',
    runtimeId: 'chronos-mirror-v2',
    suggestedCommand: 'pnpm surfaces reconcile',
  },
};

export function getControlPlaneBaseUrl(surface: ControlPlaneSurface, override?: string): string {
  return String(override || DEFAULT_BASE_URLS[surface]).replace(/\/$/, '');
}

function resolveToken(surface: ControlPlaneSurface, override?: string): string {
  if (override) return override;
  if (surface === 'chronos') {
    return String(
      getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN') ||
        getRegisteredEnvText('KYBERION_API_TOKEN') ||
        ''
    );
  }
  return '';
}

export function getControlPlaneRemediationPlan(
  surface: ControlPlaneSurface
): ControlPlaneRemediationPlan {
  return DEFAULT_REMEDIATION_PLANS[surface];
}

function inferSurfaceMismatchMessage(
  surface: ControlPlaneSurface,
  pathname: string,
  text: string
): string | null {
  const normalized = String(text || '');
  const isExpressMismatch = normalized.includes('Cannot GET') && normalized.includes(pathname);
  const isNextNotFound =
    /404[:\s]/i.test(normalized) && normalized.includes('This page could not be found.');
  if (!isExpressMismatch && !isNextNotFound) {
    return null;
  }
  return `${surface} surface does not expose ${pathname}. This usually means an older process is still serving the port or the surface was not restarted after the latest build.`;
}

function suggestedCommandFor(surface: ControlPlaneSurface): string {
  return getControlPlaneRemediationPlan(surface).suggestedCommand;
}

async function requestControlPlane(
  surface: ControlPlaneSurface,
  pathname: string,
  init?: RequestInit,
  options?: ControlPlaneClientOptions
): Promise<Response> {
  const token = resolveToken(surface, options?.token);
  const timeoutMs = options?.timeoutMs ?? 5000;
  const retryCount = options?.retryCount ?? 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`control-plane request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    try {
      const response = await fetch(
        `${getControlPlaneBaseUrl(surface, options?.baseUrl)}${pathname}`,
        {
          ...init,
          signal: controller.signal,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(init?.headers || {}),
          },
        }
      );
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retryCount) {
        await sleep(150 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`control-plane request failed for ${surface}${pathname}`);
}

export async function requestControlPlaneJson(
  surface: ControlPlaneSurface,
  pathname: string,
  init?: RequestInit,
  options?: ControlPlaneClientOptions
): Promise<unknown> {
  const response = await requestControlPlane(
    surface,
    pathname,
    {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    },
    options
  );
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? parseSafeJsonInput(text, 'control-plane response') : null;
  } catch {
    body = { ok: response.ok, raw: text };
  }
  if (!response.ok) {
    const mismatch = inferSurfaceMismatchMessage(surface, pathname, text);
    const errorMessage = isRecord(body) ? optionalString(body.error) : undefined;
    const rawMessage = isRecord(body) ? optionalString(body.raw) : undefined;
    throw new ControlPlaneClientError(
      mismatch || errorMessage || rawMessage || `HTTP ${response.status}`,
      {
        surface,
        pathname,
        suggestedCommand: mismatch ? suggestedCommandFor(surface) : undefined,
      }
    );
  }
  if (isRecord(body) && typeof body.raw === 'string') {
    const mismatch = inferSurfaceMismatchMessage(surface, pathname, body.raw);
    if (mismatch) {
      throw new ControlPlaneClientError(mismatch, {
        surface,
        pathname,
        suggestedCommand: suggestedCommandFor(surface),
      });
    }
  }
  return body;
}

export async function requestControlPlaneText(
  surface: ControlPlaneSurface,
  pathname: string,
  init?: RequestInit,
  options?: ControlPlaneClientOptions
): Promise<string> {
  const response = await requestControlPlane(surface, pathname, init, options);
  const text = await response.text();
  if (!response.ok) {
    const mismatch = inferSurfaceMismatchMessage(surface, pathname, text);
    throw new ControlPlaneClientError(mismatch || text || `HTTP ${response.status}`, {
      surface,
      pathname,
      suggestedCommand: mismatch ? suggestedCommandFor(surface) : undefined,
    });
  }
  return text;
}

export function createControlPlaneClient(
  surface: ControlPlaneSurface,
  options?: ControlPlaneClientOptions
) {
  function sanitizeNextActions(value: unknown): ChronosOverviewRecord['nextActions'] {
    if (!Array.isArray(value)) return [];
    const sanitized = value.filter((candidate) => validateNextActionContract(candidate).valid);
    return sanitized as ChronosOverviewRecord['nextActions'];
  }

  return {
    surface,
    baseUrl: getControlPlaneBaseUrl(surface, options?.baseUrl),
    async getJson<T = unknown>(pathname: string): Promise<T> {
      return requestControlPlaneJson(surface, pathname, undefined, options) as Promise<T>;
    },
    async postJson<T = unknown>(pathname: string, payload: unknown): Promise<T> {
      return requestControlPlaneJson(
        surface,
        pathname,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
        options
      ) as Promise<T>;
    },
    async getText(pathname: string) {
      return requestControlPlaneText(surface, pathname, undefined, options);
    },
    async listProjects(): Promise<ControlPlaneProjectRecord[]> {
      const body = await requestControlPlaneJson(surface, '/api/projects', undefined, options);
      return isRecord(body)
        ? recordArray(body.items)
            .map(normalizeProjectRecord)
            .filter((record): record is ControlPlaneProjectRecord => record !== null)
        : [];
    },
    async listApprovals(): Promise<ControlPlaneApprovalRecord[]> {
      const pathname = surface === 'chronos' ? '/api/intelligence' : '/api/approvals';
      const body = await requestControlPlaneJson(surface, pathname, undefined, options);
      if (!isRecord(body)) return [];
      const records = surface === 'chronos' ? body.pendingApprovals : body.items;
      return recordArray(records)
        .map(normalizeApprovalRecord)
        .filter((record): record is ControlPlaneApprovalRecord => record !== null);
    },
    async listMissionSeeds(): Promise<ControlPlaneMissionSeedRecord[]> {
      const pathname = surface === 'chronos' ? '/api/intelligence' : '/api/mission-seeds';
      const body = await requestControlPlaneJson(surface, pathname, undefined, options);
      if (!isRecord(body)) return [];
      const records = surface === 'chronos' ? body.missionSeeds : body.items;
      return recordArray(records)
        .map(normalizeMissionSeedRecord)
        .filter((record): record is ControlPlaneMissionSeedRecord => record !== null);
    },
    async listProjectTracks(): Promise<ControlPlaneProjectTrackRecord[]> {
      const pathname = surface === 'chronos' ? '/api/intelligence' : '/api/project-tracks';
      const body = await requestControlPlaneJson(surface, pathname, undefined, options);
      if (!isRecord(body)) return [];
      if (surface === 'chronos') {
        const tracks = recordArray(body.projectTracks)
          .map(normalizeProjectTrackRecord)
          .filter((record): record is ControlPlaneProjectTrackRecord => record !== null);
        const readiness = new Map(
          recordArray(body.gateReadiness)
            .map((item) => {
              const trackId = optionalString(item.track_id);
              const gateReadiness = normalizeGateReadiness(item);
              return trackId && gateReadiness ? ([trackId, gateReadiness] as const) : null;
            })
            .filter(
              (
                item
              ): item is readonly [
                string,
                NonNullable<ControlPlaneProjectTrackRecord['gate_readiness']>,
              ] => item !== null
            )
        );
        return tracks.map((track) => ({
          ...track,
          gate_readiness: track.gate_readiness || readiness.get(track.track_id),
        }));
      }
      return recordArray(body.items)
        .map(normalizeProjectTrackRecord)
        .filter((record): record is ControlPlaneProjectTrackRecord => record !== null);
    },
    async listOutcomes(): Promise<ControlPlaneOutcomeRecord[]> {
      const body = await requestControlPlaneJson(surface, '/api/outcomes', undefined, options);
      return isRecord(body)
        ? recordArray(body.items)
            .map(normalizeOutcomeRecord)
            .filter((record): record is ControlPlaneOutcomeRecord => record !== null)
        : [];
    },
    async listTaskSessions(): Promise<ControlPlaneTaskSessionRecord[]> {
      const body = await requestControlPlaneJson(surface, '/api/task-sessions', undefined, options);
      return isRecord(body)
        ? recordArray(body.items)
            .map(normalizeTaskSessionRecord)
            .filter((record): record is ControlPlaneTaskSessionRecord => record !== null)
        : [];
    },
    async getChronosOverview(): Promise<ChronosOverviewRecord> {
      const body = await requestControlPlaneJson(
        'chronos',
        '/api/intelligence',
        undefined,
        options
      );
      if (!isRecord(body)) return {};

      const projects = Array.isArray(body.projects)
        ? recordArray(body.projects)
            .map(normalizeProjectRecord)
            .filter((record): record is ControlPlaneProjectRecord => record !== null)
        : undefined;
      const projectTracks = Array.isArray(body.projectTracks)
        ? recordArray(body.projectTracks)
            .map(normalizeProjectTrackRecord)
            .filter((record): record is ControlPlaneProjectTrackRecord => record !== null)
        : undefined;
      const gateReadiness = Array.isArray(body.gateReadiness)
        ? recordArray(body.gateReadiness).flatMap((value) => {
            if (typeof value.track_id !== 'string' || !value.track_id) return [];
            const readiness = normalizeGateReadiness(value);
            return [{ track_id: value.track_id, ...(readiness ?? {}) }];
          })
        : undefined;
      const missionSeeds = Array.isArray(body.missionSeeds)
        ? recordArray(body.missionSeeds)
            .map(normalizeMissionSeedRecord)
            .filter((record): record is ControlPlaneMissionSeedRecord => record !== null)
        : undefined;
      const pendingApprovals = Array.isArray(body.pendingApprovals)
        ? recordArray(body.pendingApprovals)
            .map(normalizeApprovalRecord)
            .filter((record): record is ControlPlaneApprovalRecord => record !== null)
        : undefined;
      const distillCandidates = Array.isArray(body.distillCandidates)
        ? recordArray(body.distillCandidates)
            .map(normalizeDistillCandidateRecord)
            .filter((record): record is ControlPlaneDistillCandidateRecord => record !== null)
        : undefined;
      const memoryCandidates = Array.isArray(body.memoryCandidates)
        ? recordArray(body.memoryCandidates)
            .map(normalizeMemoryCandidateRecord)
            .filter((record): record is ControlPlaneMemoryCandidateRecord => record !== null)
        : undefined;
      const missionSeedAssessment = normalizeMissionSeedAssessment(body.missionSeedAssessment);

      return {
        ...(optionalString(body.accessRole) !== undefined
          ? { accessRole: optionalString(body.accessRole) }
          : {}),
        ...(projects !== undefined ? { projects } : {}),
        ...(projectTracks !== undefined ? { projectTracks } : {}),
        ...(gateReadiness !== undefined ? { gateReadiness } : {}),
        ...(missionSeeds !== undefined ? { missionSeeds } : {}),
        ...(missionSeedAssessment !== undefined ? { missionSeedAssessment } : {}),
        ...(pendingApprovals !== undefined ? { pendingApprovals } : {}),
        ...(distillCandidates !== undefined ? { distillCandidates } : {}),
        ...(memoryCandidates !== undefined ? { memoryCandidates } : {}),
        nextActions: sanitizeNextActions(body.nextActions),
      };
    },
  };
}
import { sleep } from './async-utils.js';
