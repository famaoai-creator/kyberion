import { randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  type IntentResolutionContract,
} from './intent-resolution-contract.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeLstat,
  safeRmSync,
} from './secure-io.js';
import { buildExecutionEnv, withExecutionContext } from './authority.js';
import {
  emitMissionOrchestrationObservation,
  enqueueMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
} from './mission-orchestration-events.js';
import { appendGovernedArtifactJsonl, writeGovernedArtifactJson } from './artifact-store.js';
import type { AgentRoutingDecision } from './intent-contract.js';
import { nowIso } from './foundation/time.js';

import { getSurfaceCoordinationRole } from './surface-coordination-role-map.js';

import type {
  ChronosMissionProposalState,
  MissionProposal,
  SlackMissionIssuanceResult,
  SlackMissionProposalState,
  SurfaceMissionProposalState,
} from './channel-surface-types.js';
import { t } from './t.js';

const SURFACE_MISSION_PROPOSAL_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-mission-proposal-state.schema.json'
);

type PersistedSurfaceMissionProposalState = Omit<SurfaceMissionProposalState, 'surface'> &
  Partial<Pick<SurfaceMissionProposalState, 'surface'>>;

type SurfaceProposalRole = 'slack_bridge' | 'chronos_gateway';

export interface MissionProposalStateBinding {
  surface: string;
  channel: string;
  threadTs: string;
}

function proposalStateCatalogAtPath(filePath: string) {
  return defineCatalog<PersistedSurfaceMissionProposalState>({
    id: 'surface-mission-proposal-state',
    path: filePath,
    schema: SURFACE_MISSION_PROPOSAL_SCHEMA_PATH,
  });
}

/** Load a persisted proposal through schema validation and ingress identity binding. */
export function loadMissionProposalStateAtPath(
  filePath: string,
  expected?: Partial<MissionProposalStateBinding>
): SurfaceMissionProposalState {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[SURFACE_MISSION_PROPOSAL] state must be a regular file: ${filePath}`);
  }
  const loaded = proposalStateCatalogAtPath(safeFilePath).load();
  const surface = loaded.surface ?? expected?.surface;
  if (!surface) {
    throw new Error(`[SURFACE_MISSION_PROPOSAL] state is missing surface binding: ${safeFilePath}`);
  }
  const state: SurfaceMissionProposalState = { ...loaded, surface };
  for (const key of ['surface', 'channel', 'threadTs'] as const) {
    const expectedValue = expected?.[key];
    if (expectedValue !== undefined && state[key] !== expectedValue) {
      throw new Error(
        `[SURFACE_MISSION_PROPOSAL_SCOPE_MISMATCH] ${key} '${state[key]}' does not match expected '${expectedValue}'`
      );
    }
  }
  return state;
}

function writeJsonAs(role: SurfaceProposalRole, logicalPath: string, record: unknown): string {
  return writeGovernedArtifactJson(role, logicalPath, record);
}

function appendJsonlAs(role: SurfaceProposalRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function withSurfaceRole<T>(role: SurfaceProposalRole, fn: () => T): T {
  return withExecutionContext(role, fn);
}

function emitSlackMissionEvent(event: Record<string, unknown>): string {
  return appendJsonlAs(
    'slack_bridge',
    'active/shared/observability/channels/slack/missions.jsonl',
    {
      ts: nowIso(),
      event_id: randomUUID(),
      channel: 'slack',
      ...event,
    }
  );
}

function emitChronosMissionEvent(event: Record<string, unknown>): string {
  return appendJsonlAs('chronos_gateway', 'active/shared/observability/chronos/missions.jsonl', {
    ts: nowIso(),
    event_id: randomUUID(),
    channel: 'chronos',
    ...event,
  });
}

function missionProposalStateLogicalPath(
  surface: string,
  channel: string,
  threadTs: string
): string {
  const safeThread = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `active/shared/coordination/channels/${surface}/mission-proposals/${channel}-${safeThread}.json`;
}

/**
 * SN-01 Phase 2: surface-neutral pending-proposal store. Any ingress surface
 * (telegram, iMessage, terminal, …) can persist a proposal awaiting the
 * user's numbered-choice confirmation and later confirm/reject it with the
 * same UX contract Slack uses. Writes run under the surface's coordination
 * role from the shared role map.
 */
export function saveMissionProposalState(params: {
  surface: string;
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): string {
  const surface = params.surface.trim().toLowerCase();
  return writeGovernedArtifactJson(
    getSurfaceCoordinationRole(surface),
    missionProposalStateLogicalPath(surface, params.channel, params.threadTs),
    {
      surface,
      channel: params.channel,
      threadTs: params.threadTs,
      proposal: params.proposal,
      sourceText: params.sourceText,
      routingDecision: params.routingDecision,
      createdAt: nowIso(),
    } satisfies SurfaceMissionProposalState
  );
}

export function getMissionProposalState(
  surface: string,
  channel: string,
  threadTs: string
): SurfaceMissionProposalState | null {
  const resolved = pathResolver.resolve(
    missionProposalStateLogicalPath(surface.trim().toLowerCase(), channel, threadTs)
  );
  const safeResolved = assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  if (!safeExistsSync(safeResolved)) return null;
  return loadMissionProposalStateAtPath(safeResolved, {
    surface: surface.trim().toLowerCase(),
    channel,
    threadTs,
  });
}

export function clearMissionProposalState(
  surface: string,
  channel: string,
  threadTs: string
): void {
  const normalized = surface.trim().toLowerCase();
  const resolved = pathResolver.resolve(
    missionProposalStateLogicalPath(normalized, channel, threadTs)
  );
  if (!safeExistsSync(resolved)) return;
  withExecutionContext(getSurfaceCoordinationRole(normalized), () => {
    safeRmSync(resolved, { force: true });
  });
}

function sanitizeMissionSlug(value: string): string {
  return (
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'REQUEST'
  );
}

function buildSurfaceMissionId(
  prefix: string,
  threadTs: string,
  proposal: MissionProposal,
  sourceText?: string
): string {
  const base = proposal.summary || sourceText || proposal.why || proposal.mission_type || 'request';
  const slug = sanitizeMissionSlug(base);
  const numericThread = threadTs.replace(/\D+/g, '').slice(-8) || Date.now().toString().slice(-8);
  return `MSN-${prefix}-${slug}-${numericThread}`;
}

function formatRoutingDecisionSummary(routingDecision?: AgentRoutingDecision): string | undefined {
  if (!routingDecision) return undefined;
  const parts: string[] = [routingDecision.mode];
  if (routingDecision.owner) parts.push(`owner=${routingDecision.owner}`);
  if (routingDecision.fanout && routingDecision.fanout !== 'none')
    parts.push(`fanout=${routingDecision.fanout}`);
  return parts.join(', ');
}

export function getSlackMissionProposalState(
  channel: string,
  threadTs: string
): SlackMissionProposalState | null {
  const logicalPath = missionProposalStateLogicalPath('slack', channel, threadTs);
  const resolved = pathResolver.resolve(logicalPath);
  const safeResolved = assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  if (!safeExistsSync(safeResolved)) return null;
  const state = loadMissionProposalStateAtPath(safeResolved, {
    surface: 'slack',
    channel,
    threadTs,
  });
  return { ...state, surface: 'slack' };
}

export function saveSlackMissionProposalState(params: {
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): string {
  return writeJsonAs(
    'slack_bridge',
    missionProposalStateLogicalPath('slack', params.channel, params.threadTs),
    {
      surface: 'slack',
      channel: params.channel,
      threadTs: params.threadTs,
      proposal: params.proposal,
      sourceText: params.sourceText,
      routingDecision: params.routingDecision,
      createdAt: nowIso(),
    } satisfies SlackMissionProposalState
  );
}

export function clearSlackMissionProposalState(channel: string, threadTs: string): void {
  const resolved = pathResolver.resolve(
    missionProposalStateLogicalPath('slack', channel, threadTs)
  );
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('slack_bridge', () => {
    safeRmSync(resolved, { force: true });
  });
}

export function getChronosMissionProposalState(
  sessionId: string
): ChronosMissionProposalState | null {
  const logicalPath = missionProposalStateLogicalPath('chronos', 'chronos', sessionId);
  const resolved = pathResolver.resolve(logicalPath);
  const safeResolved = assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  if (!safeExistsSync(safeResolved)) return null;
  const state = loadMissionProposalStateAtPath(safeResolved, {
    surface: 'chronos',
    channel: 'chronos',
    threadTs: sessionId,
  });
  return { ...state, surface: 'chronos', channel: 'chronos', threadTs: sessionId };
}

export function saveChronosMissionProposalState(params: {
  sessionId: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): string {
  return writeJsonAs(
    'chronos_gateway',
    missionProposalStateLogicalPath('chronos', 'chronos', params.sessionId),
    {
      surface: 'chronos',
      channel: 'chronos',
      threadTs: params.sessionId,
      proposal: params.proposal,
      sourceText: params.sourceText,
      routingDecision: params.routingDecision,
      createdAt: nowIso(),
    } satisfies ChronosMissionProposalState
  );
}

export function clearChronosMissionProposalState(sessionId: string): void {
  const resolved = pathResolver.resolve(
    missionProposalStateLogicalPath('chronos', 'chronos', sessionId)
  );
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('chronos_gateway', () => {
    safeRmSync(resolved, { force: true });
  });
}

/**
 * SN-01 Phase 2: the numbered-choice confirmation UX ('1 / 実行する / yes' vs
 * '2 / やめる / cancel') is surface-neutral — these are the canonical names.
 * The Slack-named exports below remain for existing callers.
 */
export function isMissionConfirmation(text: string): boolean {
  return isSlackMissionConfirmation(text);
}

export function isMissionRejection(text: string): boolean {
  return isSlackMissionRejection(text);
}

/**
 * Shared ingress logic for messaging bridges: given an incoming message,
 * resolve any pending mission proposal on (surface, channel, thread).
 * Returns `handled: false` when there is no pending proposal or the text is
 * neither a confirmation nor a rejection (the bridge should run its normal
 * conversation flow); otherwise performs the cancel/issue and returns the
 * reply text the bridge should send verbatim.
 */
export async function resolveMissionProposalReply(params: {
  surface: string;
  channel: string;
  thread: string;
  text: string;
}): Promise<{ handled: false } | { handled: true; reply: string; missionId?: string }> {
  const pending = getMissionProposalState(params.surface, params.channel, params.thread);
  if (!pending) return { handled: false };

  if (isMissionRejection(params.text)) {
    clearMissionProposalState(params.surface, params.channel, params.thread);
    return {
      handled: true,
      reply: t('bridge:mission_proposal_cancelled', undefined, 'ja'),
    };
  }
  if (isMissionConfirmation(params.text)) {
    const issued = await issueMissionFromProposal({
      surface: params.surface,
      channel: params.channel,
      thread: params.thread,
      proposal: pending.proposal,
      sourceText: pending.sourceText,
      routingDecision: pending.routingDecision,
    });
    clearMissionProposalState(params.surface, params.channel, params.thread);
    return {
      handled: true,
      missionId: issued.missionId,
      reply: buildMissionIssuanceReply(issued),
    };
  }
  return { handled: false };
}

/** Render the surface-neutral mission issuance result for messaging bridges. */
export function buildMissionIssuanceReply(
  issued: Pick<
    SlackMissionIssuanceResult,
    'missionId' | 'missionType' | 'tier' | 'orchestrationStatus' | 'orchestrationError'
  >
): string {
  const locale = 'ja' as const;
  return [
    t('bridge:mission_issued_started', { missionId: issued.missionId }, locale),
    t(
      'bridge:mission_issued_type_tier',
      { missionType: issued.missionType, tier: issued.tier },
      locale
    ),
    issued.orchestrationStatus === 'queued'
      ? t('bridge:mission_issued_queued', undefined, locale)
      : t(
          'bridge:mission_issued_queue_failed',
          { error: issued.orchestrationError || 'unknown' },
          locale
        ),
  ].join('\n');
}

/**
 * Companion to {@link resolveMissionProposalReply}: persist a proposal the
 * surface orchestrator produced and return the numbered-choice prompt the
 * bridge should send.
 */
export function stashMissionProposalForConfirmation(params: {
  surface: string;
  channel: string;
  thread: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  fallbackSummary?: string;
  intentResolution?: IntentResolutionContract;
}): string {
  saveMissionProposalState({
    surface: params.surface,
    channel: params.channel,
    threadTs: params.thread,
    proposal: params.proposal,
    sourceText: params.sourceText,
    routingDecision: params.routingDecision,
  });
  const summary =
    String(params.proposal.summary || params.fallbackSummary || '').trim() ||
    t('bridge:mission_proposal_fallback', undefined, 'ja');
  return buildMissionProposalConfirmationText({
    summary,
    intentResolution: params.intentResolution,
  });
}

export function buildMissionProposalConfirmationText(params: {
  summary: string;
  intentResolution?: IntentResolutionContract;
}): string {
  const locale = 'ja' as const;
  return [
    `${params.summary}\n${t('bridge:mission_proposal_confirmation_choices', undefined, locale)}`,
    ...(params.intentResolution
      ? [
          `${t('bridge:contract_authority', undefined, locale)}: ${renderIntentAuthorityLabel(params.intentResolution.authority_level, locale)}`,
          `${t('bridge:contract_next_action', undefined, locale)}: ${params.intentResolution.next_action.label}`,
          `${t('bridge:contract_consequence', undefined, locale)}: ${params.intentResolution.next_action.consequence}`,
          `${t('bridge:contract_outcome', undefined, locale)}: ${renderIntentOutcomeLabel(params.intentResolution.outcome_kind, locale)}`,
        ]
      : []),
  ].join('\n');
}

export function isSlackMissionConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    // UX-04: numbered-choice acceptance — '1) 実行する 2) やめる'
    /^1[).。]?$/,
    /^実行する[。!！]?$/,
    /^作成する[。!！]?$/,
    /^はい[。！!]?$/,
    /^お願いします?[。！!]?$/,
    /^ではよろしく[。！!]?$/,
    /^よろしくお願いします?[。！!]?$/,
    /^進めて$/,
    /^go ahead$/,
    /^yes$/,
    /^approved?$/,
    /^please proceed$/,
  ].some((pattern) => pattern.test(normalized));
}

/**
 * UX-04 acceptance 2: the numbered-choice prompt needs an explicit decline
 * path so "やめる" (or 2 / no / cancel) clears the pending proposal instead
 * of being ignored.
 */
export function isSlackMissionRejection(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    /^2[).。]?$/,
    /^やめる[。!！]?$/,
    /^やめて[。!！]?$/,
    /^キャンセル[。!！]?$/,
    /^中止[。!！]?$/,
    /^no[.!]?$/,
    /^cancel$/,
    /^stop$/,
    /^reject(ed)?$/,
  ].some((pattern) => pattern.test(normalized));
}

export interface MissionIssuanceParams {
  /** Originating surface ('slack' | 'chronos' | 'terminal' | 'telegram' | …). */
  surface: string;
  /** Reply channel on that surface ('terminal' for CLI sessions). */
  channel: string;
  /** Thread / session / correlation key on that surface. */
  thread: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  /** Authority role recorded on the orchestration event (default `<surface>_bridge`). */
  requestedBy?: string;
}

/**
 * SN-01: canonical, surface-neutral mission issuance. Every ingress surface
 * (Slack, Chronos, terminal/CLI, messaging bridges) converges here so the
 * orchestration chain and the result-return payload are identical regardless
 * of where the request arrived. The payload carries `surface` so downstream
 * workers can route observability and result outboxes back to the requester.
 */
export async function issueMissionFromProposal(
  params: MissionIssuanceParams
): Promise<SlackMissionIssuanceResult> {
  const surface = params.surface.trim().toLowerCase() || 'slack';
  const missionId = buildSurfaceMissionId(
    surface.toUpperCase(),
    params.thread,
    params.proposal,
    params.sourceText
  );
  const tier = params.proposal.tier || 'public';
  const missionType = params.proposal.mission_type || 'development';
  const persona = params.proposal.assigned_persona || 'Ecosystem Architect';
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const routingDecisionArg = params.routingDecision
    ? ['--routing-decision', JSON.stringify(params.routingDecision)]
    : [];

  // process.execPath, not 'node': PATH lookup breaks (ELOOP) when any PATH
  // entry is a looping symlink — observed live with a broken CLI install dir.
  const startOutput = safeExec(
    process.execPath,
    [
      'dist/scripts/mission_controller.js',
      'start',
      missionId,
      tier,
      persona,
      'default',
      missionType,
      ...routingDecisionArg,
    ],
    { env, cwd: pathResolver.rootDir() }
  );
  let orchestrationStatus: SlackMissionIssuanceResult['orchestrationStatus'] = 'queued';
  let orchestrationJobPath: string | undefined;
  let orchestrationError: string | undefined;
  try {
    // The issuance ceremony itself is the governed writer: surfaces without
    // their own orchestration write scope (terminal, messaging bridges) still
    // enqueue through the mission_controller execution context.
    orchestrationJobPath = withExecutionContext('mission_controller', () => {
      const orchestrationEvent = enqueueMissionOrchestrationEvent({
        eventType: 'mission_issue_requested',
        missionId,
        requestedBy: params.requestedBy || `${surface}_bridge`,
        correlationId: randomUUID(),
        payload: {
          surface,
          channel: params.channel,
          threadTs: params.thread,
          proposal: params.proposal,
          sourceText: params.sourceText,
          tier,
          persona,
          missionType,
        },
      });
      return startMissionOrchestrationWorker(orchestrationEvent);
    });
  } catch (error) {
    orchestrationStatus = 'failed';
    orchestrationError = error instanceof Error ? error.message : String(error);
  }

  emitSurfaceMissionIssueEvent(surface, {
    correlation_id: randomUUID(),
    decision: 'mission_issued',
    why: `A confirmed ${surface} mission proposal was deterministically issued through mission_controller.`,
    policy_used: `${surface}_mission_issue_v1`,
    agent_id: 'mission_controller',
    resource_id: missionId,
    thread_ts: params.thread,
    surface_channel: params.channel,
    mission_type: missionType,
    tier,
    routing_decision_summary: formatRoutingDecisionSummary(params.routingDecision),
    orchestration_status: orchestrationStatus,
    orchestration_job_path: orchestrationJobPath,
  });

  return {
    missionId,
    tier,
    missionType,
    persona,
    startOutput,
    orchestrationStatus,
    orchestrationJobPath,
    orchestrationError,
    routingDecision: params.routingDecision,
  };
}

function emitSurfaceMissionIssueEvent(surface: string, event: Record<string, unknown>): void {
  if (surface === 'slack') {
    emitSlackMissionEvent({ ...event, slack_channel: event.surface_channel });
    return;
  }
  if (surface === 'chronos') {
    emitChronosMissionEvent(event);
    return;
  }
  // Surfaces without a dedicated channel stream record into the shared
  // mission-control observability stream (mission_controller-writable).
  withExecutionContext('mission_controller', () =>
    emitMissionOrchestrationObservation({ surface_channel: surface, ...event })
  );
}

export async function issueSlackMissionFromProposal(params: {
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): Promise<SlackMissionIssuanceResult> {
  return issueMissionFromProposal({
    surface: 'slack',
    channel: params.channel,
    thread: params.threadTs,
    proposal: params.proposal,
    sourceText: params.sourceText,
    routingDecision: params.routingDecision,
    requestedBy: 'slack_bridge',
  });
}

export async function issueChronosMissionFromProposal(params: {
  sessionId: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
}): Promise<SlackMissionIssuanceResult> {
  return issueMissionFromProposal({
    surface: 'chronos',
    channel: 'chronos',
    thread: params.sessionId,
    proposal: params.proposal,
    sourceText: params.sourceText,
    routingDecision: params.routingDecision,
    requestedBy: 'chronos_gateway',
  });
}
