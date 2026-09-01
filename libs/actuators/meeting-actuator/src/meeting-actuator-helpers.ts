/**
 * Meeting Actuator — abstracts Zoom / Teams / Google Meet behind a
 * single ADF surface (join / leave / speak / listen / chat / status).
 *
 * Guardrails (audit-load-bearing):
 *
 *   1. **Voice consent gate** — `speak` is refused unless the active
 *      mission's evidence/voice-consent.json declares
 *      `consent: granted` from the operator (or sudo override).
 *   2. **Audit emission** — every action emits a `meeting.<verb>`
 *      audit-chain entry with `tenant_slug` (when set), platform, and
 *      a redacted reference to the meeting URL. Failures emit a
 *      `meeting.<verb>_failed` event with the error reason.
 *   3. **Persona binding** — when a tenant slug is set on the active
 *      identity, the audit entry inherits it so per-tenant SIEMs see
 *      only their own meeting activity.
 *
 * The Python `meeting-bridge.py` is a thin platform driver. Real
 * Zoom / Teams / Meet integration is a deployment-time concern (drop
 * in a vendor SDK behind the same JSON contract).
 */

import { auditChain } from '@agent/core/audit-chain';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { retry } from '@agent/core/async-utils';
import { createActuatorTrace, finalizeActuatorTrace } from '@agent/core/actuator-trace';
import { resolveIdentityContext } from '@agent/core/authority';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import { resolveVars } from '@agent/core/src/logic-utils';
import { runOpPreflight } from '@agent/core/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { loadJson, getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditSpeakerFairnessOp,
  conduct1on1,
  executeSelfActionItemsOp,
  extractActionItemsOp,
  generateFacilitationScriptOp,
  generateReminderMessageOp,
  runActionItemReminderSweepOp,
  trackPendingActionItemsOp,
} from './meeting-intelligence-ops.js';

function resolveMeetingPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

function resolveExistingMeetingFile(ref: string, label: string): string {
  const resolved = resolveMeetingPath(ref, false);
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`[MEETING_RESOURCE_FILE] ${label} must be a regular file: ${ref}`);
  }
  return resolved;
}
import { resolveMeetingProvider } from './meeting-provider-adapters.js';

export interface MeetingAction {
  action: 'check_consent' | 'join' | 'leave' | 'speak' | 'listen' | 'chat' | 'status';
  params: {
    platform: 'zoom' | 'teams' | 'meet' | 'auto';
    provider?: 'google_meet' | 'teams_pipeline' | 'zoom' | 'auto';
    provider_profile_id?: string;
    execution_profile_id?: string;
    mode?: 'transcribe' | 'realtime';
    node?: 'local' | 'named-node';
    audio_bridge?: 'blackhole' | 'pulseaudio' | 'none';
    url_policy?: 'explicit_only' | 'explicit_or_detected';
    url?: string;
    meeting_id?: string;
    passcode?: string;
    text?: string;
    duration_sec?: number;
    transcript_path?: string;
  };
}

export interface MeetingPipelineAction {
  action: 'pipeline';
  steps: Array<{
    type: 'capture' | 'transform' | 'apply' | 'control';
    op: string;
    params: Record<string, unknown>;
  }>;
  context?: Record<string, unknown>;
  options?: { max_steps?: number; timeout_ms?: number };
}

export interface MeetingActionResult {
  status: 'success' | 'error' | 'denied';
  action?: string;
  platform?: string;
  method?: string;
  join_backend?: string;
  provider?: string;
  provider_profile_id?: string;
  execution_profile_id?: string;
  mode?: string;
  node?: string;
  audio_bridge?: string;
  url_policy?: string;
  chars?: number;
  duration?: number;
  elapsed?: number;
  playwright_driver?: string;
  voice_bridge?: string;
  blackhole_router?: string;
  message?: string;
  audit_event_id?: string;
  trace?: unknown;
  trace_summary?: unknown;
  trace_persisted_path?: string;
  partial_state?: boolean;
  partial_reason?: string;
  transcript_path?: string;
}

const MEETING_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/meeting-actuator/manifest.json'
);
const DEFAULT_MEETING_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

interface VoiceConsentRecord {
  consent?: unknown;
  mission_id?: unknown;
  operator_handle?: unknown;
  tenant_slug?: unknown;
  expires_at?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const MEETING_ACTIONS = new Set<MeetingAction['action']>([
  'check_consent',
  'join',
  'leave',
  'speak',
  'listen',
  'chat',
  'status',
]);

/** Validate the structural CLI boundary before the typed action handler runs. */
export function parseMeetingActionInput(value: unknown): MeetingAction | MeetingPipelineAction {
  if (!isPlainObject(value) || typeof value.action !== 'string') {
    throw new Error('meeting action input must be an object with an action');
  }
  if (value.action === 'pipeline') {
    if (!Array.isArray(value.steps)) {
      throw new Error('meeting action input pipeline steps must be an array');
    }
    return value as unknown as MeetingPipelineAction;
  }
  if (!MEETING_ACTIONS.has(value.action as MeetingAction['action'])) {
    throw new Error(`meeting action input has unknown action: ${value.action}`);
  }
  if (!isPlainObject(value.params)) {
    throw new Error('meeting action input params must be an object');
  }
  return value as unknown as MeetingAction;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

const MEETING_RESULT_STRING_FIELDS = [
  'action',
  'platform',
  'method',
  'join_backend',
  'provider',
  'provider_profile_id',
  'execution_profile_id',
  'mode',
  'node',
  'audio_bridge',
  'url_policy',
  'message',
  'partial_reason',
  'transcript_path',
  'playwright_driver',
  'voice_bridge',
  'blackhole_router',
] as const;

const MEETING_RESULT_NUMBER_FIELDS = ['chars', 'duration', 'elapsed'] as const;

/** Validate the JSON envelope emitted by the Python meeting bridge. */
export function parseMeetingActionResult(value: unknown): MeetingActionResult | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.status !== 'success' && value.status !== 'error' && value.status !== 'denied') {
    return undefined;
  }

  const result: MeetingActionResult = { status: value.status };
  for (const field of MEETING_RESULT_STRING_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && typeof candidate !== 'string') return undefined;
    if (typeof candidate === 'string') result[field] = candidate;
  }
  for (const field of MEETING_RESULT_NUMBER_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && (typeof candidate !== 'number' || !Number.isFinite(candidate))) {
      return undefined;
    }
    if (typeof candidate === 'number') result[field] = candidate;
  }
  if (value.partial_state !== undefined && typeof value.partial_state !== 'boolean') {
    return undefined;
  }
  if (typeof value.partial_state === 'boolean') result.partial_state = value.partial_state;
  if (value.audit_event_id !== undefined && typeof value.audit_event_id !== 'string') {
    return undefined;
  }
  if (typeof value.audit_event_id === 'string') result.audit_event_id = value.audit_event_id;
  return result;
}

function validateGrantedConsent(
  consent: VoiceConsentRecord,
  missionId: string
): { allowed: boolean; reason?: string } {
  if (consent.consent !== 'granted') {
    return {
      allowed: false,
      reason: `voice-consent.json present but consent != 'granted' (got '${String(consent.consent)}')`,
    };
  }

  const consentMissionId = normalizeOptionalString(consent.mission_id);
  const operatorHandle = normalizeOptionalString(consent.operator_handle);
  if (!consentMissionId || !operatorHandle) {
    return {
      allowed: false,
      reason: 'voice-consent.json is malformed: mission_id and operator_handle are required',
    };
  }
  if (consentMissionId !== missionId) {
    return {
      allowed: false,
      reason: `voice-consent.json mission_id '${consentMissionId}' does not match active mission '${missionId}'`,
    };
  }

  const expiresAt = normalizeOptionalString(consent.expires_at);
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) {
      return { allowed: false, reason: `voice-consent.json expires_at is invalid: ${expiresAt}` };
    }
    if (expiresMs <= Date.now()) {
      return { allowed: false, reason: `voice-consent.json expired at ${expiresAt}` };
    }
  }

  const activeTenant = resolveIdentityContext().tenantSlug;
  if (activeTenant) {
    const consentTenant = normalizeOptionalString(consent.tenant_slug);
    if (consentTenant !== activeTenant) {
      return {
        allowed: false,
        reason: `voice-consent.json tenant_slug '${consentTenant ?? 'missing'}' does not match active tenant '${activeTenant}'`,
      };
    }
  }

  return { allowed: true };
}

export function checkSpeakConsent(): { allowed: boolean; reason?: string } {
  if (getRegisteredEnvText('KYBERION_SUDO') === 'true') return { allowed: true };
  const missionId = process.env.MISSION_ID;
  if (!missionId) {
    return {
      allowed: false,
      reason: 'speak requires MISSION_ID + voice-consent.json in the mission evidence dir',
    };
  }
  const evidenceDir = pathResolver.missionEvidenceDir(missionId);
  if (!evidenceDir) {
    return { allowed: false, reason: `mission '${missionId}' not found` };
  }
  const consentPath = assertSafeRepositoryPath(path.join(evidenceDir, 'voice-consent.json'), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(consentPath)) {
    return {
      allowed: false,
      reason: `voice-consent.json missing at ${path.relative(pathResolver.rootDir(), consentPath)}`,
    };
  }
  try {
    const consent = loadJson<unknown>(consentPath);
    if (!isPlainObject(consent)) {
      return {
        allowed: false,
        reason: 'voice-consent.json is malformed: expected an object',
      };
    }
    return validateGrantedConsent(consent, missionId);
  } catch (err: any) {
    return { allowed: false, reason: `failed to parse voice-consent.json: ${err?.message ?? err}` };
  }
}

function redactedTarget(input: MeetingAction): string {
  const url = input.params.url;
  if (!url) return `${input.params.platform}:no-url`;
  try {
    const u = new URL(url);
    return `${input.params.platform}:${u.host}${u.pathname.split('/').slice(0, 3).join('/')}`;
  } catch {
    return `${input.params.platform}:invalid-url`;
  }
}

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: MEETING_MANIFEST_PATH,
  defaults: DEFAULT_MEETING_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

function recordMeetingEvent(input: MeetingAction, result: MeetingActionResult): string {
  const isDenied = result.status === 'denied';
  const isError = result.status === 'error';
  const isPartial = result.partial_state === true;
  const action = isError
    ? `meeting.${input.action}_failed`
    : isDenied
      ? `meeting.${input.action}_denied`
      : isPartial
        ? `meeting.${input.action}_partial`
        : `meeting.${input.action}`;
  try {
    const entry = auditChain.record({
      agentId: 'meeting-actuator',
      action,
      operation: redactedTarget(input),
      result: isDenied ? 'denied' : isError ? 'error' : 'allowed',
      ...(result.message
        ? { reason: result.message }
        : isPartial && result.partial_reason
          ? { reason: result.partial_reason }
          : {}),
      metadata: {
        platform: input.params.platform,
        ...(input.params.provider ? { provider: input.params.provider } : {}),
        ...(input.params.provider_profile_id
          ? { provider_profile_id: input.params.provider_profile_id }
          : {}),
        ...(input.params.execution_profile_id
          ? { execution_profile_id: input.params.execution_profile_id }
          : {}),
        ...(input.params.mode ? { mode: input.params.mode } : {}),
        ...(input.params.node ? { node: input.params.node } : {}),
        ...(input.params.audio_bridge ? { audio_bridge: input.params.audio_bridge } : {}),
        ...(input.params.url_policy ? { url_policy: input.params.url_policy } : {}),
        ...(input.params.meeting_id ? { meeting_id: input.params.meeting_id } : {}),
        ...(input.params.duration_sec !== undefined
          ? { duration_sec: input.params.duration_sec }
          : {}),
        ...(typeof input.params.text === 'string'
          ? { speech_chars: input.params.text.length }
          : {}),
        ...(isPartial ? { partial_state: true } : {}),
        ...(result.partial_reason ? { partial_reason: result.partial_reason } : {}),
        ...(result.transcript_path ? { transcript_path: result.transcript_path } : {}),
        ...(result.join_backend ? { join_backend: result.join_backend } : {}),
      },
    });
    return entry.id;
  } catch (err: any) {
    logger.warn(`[meeting] audit emission failed: ${err?.message ?? err}`);
    return '';
  }
}

function resolveMeetingParams(value: unknown, context: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveMeetingParams(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveMeetingParams(item, context)])
    );
  }
  return resolveVars(value, context);
}

function meetingExport(
  context: Record<string, unknown>,
  params: Record<string, unknown>,
  value: unknown,
  fallback: string
) {
  return { ...context, [String(params.export_as || fallback)]: value };
}

async function executeMeetingPipeline(
  steps: MeetingPipelineAction['steps'],
  initialContext: Record<string, unknown> = {},
  options: MeetingPipelineAction['options'] = {}
) {
  const result = await runAdfActuatorPipeline({
    actuatorId: 'meeting',
    steps,
    context: { ...initialContext, timestamp: new Date().toISOString() } as Record<string, unknown>,
    options: {
      maxSteps: options.max_steps || DEFAULT_MAX_PIPELINE_STEPS,
      timeoutMs: options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS,
    },
    handlers: {
      capture: async (op, rawParams, context) => {
        if (op !== 'listen' && op !== 'status') {
          throw new Error(`[UNKNOWN_OP] Unknown meeting capture op: ${op}`);
        }
        const params = resolveMeetingParams(rawParams, context) as MeetingAction['params'];
        return meetingExport(
          context,
          params as Record<string, unknown>,
          await handleAction({ action: op, params }),
          `${op}_result`
        );
      },
      transform: async () => {
        throw new Error('[UNKNOWN_OP] Meeting intelligence does not own transform operations');
      },
      control: async () => {
        throw new Error('[UNKNOWN_OP] Meeting intelligence does not own control operations');
      },
      apply: async (op, rawParams, context) => {
        const params = resolveMeetingParams(rawParams, context) as Record<string, any>;
        const missionId = String(params.mission_id || process.env.MISSION_ID || '');
        const workItemId =
          String(params.work_item_id || context.work_item_id || '').trim() || undefined;
        switch (op) {
          case 'join':
          case 'leave':
          case 'speak':
          case 'chat':
            return meetingExport(
              context,
              params,
              await handleAction({ action: op, params: params as MeetingAction['params'] }),
              `meeting_${op}_result`
            );
          case 'conduct_1on_1':
            return meetingExport(
              context,
              params,
              await conduct1on1({
                counterparty_ref: String(params.counterparty_ref || ''),
                proposal_draft_ref: String(params.proposal_draft_ref || ''),
                structure: Array.isArray(params.structure) ? params.structure.map(String) : [],
                output_path: String(params.output_path || ''),
              }),
              'one_on_one_result'
            );
          case 'extract_action_items': {
            const transcriptPath = params.transcript_path ? String(params.transcript_path) : '';
            const transcript = transcriptPath
              ? String(
                  safeReadFile(resolveExistingMeetingFile(transcriptPath, 'transcript_path'), {
                    encoding: 'utf8',
                  })
                )
              : String(params.transcript || '');
            const attendees = (
              Array.isArray(params.attendees)
                ? params.attendees
                : Array.isArray(context[String(params.attendees_from || 'attendees')])
                  ? context[String(params.attendees_from || 'attendees')]
                  : []
            ) as Array<{
              name: string;
              person_slug?: string;
              channel_handle?: string;
              manager_handle?: string;
            }>;
            const listenResult = context.listen_result || context.meeting_listen_result;
            const partialState =
              params.partial_state !== undefined
                ? Boolean(params.partial_state)
                : Boolean(
                    listenResult &&
                    typeof listenResult === 'object' &&
                    (listenResult as any).partial_state
                  );
            const partialReason =
              params.partial_reason !== undefined
                ? String(params.partial_reason || '')
                : listenResult && typeof listenResult === 'object'
                  ? String((listenResult as any).partial_reason || '')
                  : undefined;
            const result = await extractActionItemsOp({
              mission_id: missionId,
              ...(workItemId ? { work_item_id: workItemId } : {}),
              transcript,
              attendees,
              ...(params.operator_label ? { operator_label: String(params.operator_label) } : {}),
              ...(params.default_assignee_label
                ? { default_assignee_label: String(params.default_assignee_label) }
                : {}),
              ...(params.language ? { language: String(params.language) } : {}),
              ...(partialState ? { partial_state: true } : {}),
              ...(partialReason ? { partial_reason: partialReason } : {}),
              ...(params.enforce_restricted_actions !== undefined
                ? { enforce_restricted_actions: Boolean(params.enforce_restricted_actions) }
                : {}),
            });
            return meetingExport(context, params, result, 'extracted_action_items');
          }
          case 'generate_facilitation_script':
            return meetingExport(
              context,
              params,
              await generateFacilitationScriptOp({
                ...(missionId ? { mission_id: missionId } : {}),
                ...(workItemId ? { work_item_id: workItemId } : {}),
                agenda: Array.isArray(params.agenda) ? params.agenda.map(String) : undefined,
                ...(params.current_topic ? { current_topic: String(params.current_topic) } : {}),
                ...(params.recent_transcript_chunk
                  ? { recent_transcript_chunk: String(params.recent_transcript_chunk) }
                  : {}),
                ...(params.remaining_minutes !== undefined
                  ? { remaining_minutes: Number(params.remaining_minutes) }
                  : {}),
                ...(params.facilitator_persona_label
                  ? { facilitator_persona_label: String(params.facilitator_persona_label) }
                  : {}),
                ...(params.language ? { language: String(params.language) } : {}),
              }),
              'facilitation_script'
            );
          case 'generate_reminder_message': {
            const item = params.item || context[String(params.item_from || 'item')];
            if (!item || typeof item !== 'object') {
              throw new Error('generate_reminder_message: missing params.item (ActionItem)');
            }
            return meetingExport(
              context,
              params,
              await generateReminderMessageOp({
                item: item as any,
                ...(missionId ? { mission_id: missionId } : {}),
                ...(workItemId ? { work_item_id: workItemId } : {}),
                ...(params.days_overdue !== undefined
                  ? { days_overdue: Number(params.days_overdue) }
                  : {}),
                ...(params.tone ? { tone: params.tone } : {}),
                ...(params.language ? { language: String(params.language) } : {}),
              }),
              'reminder_message'
            );
          }
          case 'run_action_item_reminder_sweep':
            return meetingExport(
              context,
              params,
              await runActionItemReminderSweepOp({
                ...(Array.isArray(params.mission_ids)
                  ? { mission_ids: params.mission_ids.map(String) }
                  : {}),
                tone: params.tone as 'friendly' | 'formal' | 'urgent' | undefined,
                language: String(params.language || 'ja'),
                max_items_per_mission: Number(params.max_items || 20),
                ...(params.report_path ? { report_path: String(params.report_path) } : {}),
              }),
              'reminder_sweep_report'
            );
          case 'execute_self_action_items': {
            if (!missionId) throw new Error('execute_self_action_items: mission_id is required');
            const result = await executeSelfActionItemsOp({
              mission_id: missionId,
              ...(workItemId ? { work_item_id: workItemId } : {}),
              language: String(params.language || 'ja'),
            });
            if (params.output_path) {
              safeWriteFile(
                resolveMeetingPath(String(params.output_path)),
                JSON.stringify(result, null, 2)
              );
            }
            return meetingExport(context, params, result, 'self_action_items_report');
          }
          case 'track_pending_action_items': {
            if (!missionId) throw new Error('track_pending_action_items: mission_id is required');
            const result = await trackPendingActionItemsOp({
              mission_id: missionId,
              ...(workItemId ? { work_item_id: workItemId } : {}),
              tone: params.tone as 'friendly' | 'formal' | 'urgent' | undefined,
              language: String(params.language || 'ja'),
              max_items: Number(params.max_items || 20),
            });
            return meetingExport(context, params, result, 'pending_action_items_report');
          }
          case 'audit_speaker_fairness': {
            if (!missionId) throw new Error('audit_speaker_fairness: mission_id is required');
            const report = auditSpeakerFairnessOp({ mission_id: missionId });
            if (params.output_path) {
              safeWriteFile(
                resolveMeetingPath(String(params.output_path)),
                JSON.stringify(report, null, 2)
              );
            }
            return meetingExport(context, params, report, 'speaker_fairness_report');
          }
          default:
            throw new Error(`[UNKNOWN_OP] Unknown meeting op: ${op}`);
        }
      },
    },
  });
  return result as unknown as Record<string, unknown>;
}

export async function handleAction(
  input: MeetingAction | MeetingPipelineAction
): Promise<MeetingActionResult | Record<string, unknown>> {
  if (input.action === 'pipeline') {
    return await executeMeetingPipeline(input.steps || [], input.context || {}, input.options);
  }
  if (input.action === 'check_consent') {
    const consent = checkSpeakConsent();
    return {
      status: consent.allowed ? 'success' : 'denied',
      kind: 'voice_consent_check',
      allowed: consent.allowed,
      ...(consent.reason ? { message: consent.reason } : {}),
    };
  }
  const providerAdapter = resolveMeetingProvider(input.params.provider, input.params.url);
  if (providerAdapter && input.params.provider === 'auto') {
    input = {
      ...input,
      params: {
        ...input.params,
        provider:
          providerAdapter.id === 'google_meet'
            ? 'google_meet'
            : providerAdapter.id === 'teams'
              ? 'teams_pipeline'
              : 'zoom',
        platform: providerAdapter.id === 'google_meet' ? 'meet' : providerAdapter.id,
      },
    };
  }
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `meeting:${input.action}`,
    params: input.params || {},
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation meeting:${input.action} was not admitted.`}`
    );
  }
  input = { ...input, params: preflight.input as MeetingAction['params'] };
  const traceCtx = createActuatorTrace('meeting-actuator', input.action, {
    pipelineId: input.params.meeting_id,
  });
  traceCtx.startSpan(`meeting:${input.action}`, {
    platform: input.params.platform,
  });

  if (input.action === 'speak') {
    const consent = checkSpeakConsent();
    if (!consent.allowed) {
      const denied: MeetingActionResult = {
        status: 'denied',
        platform: input.params.platform,
        message: consent.reason,
      };
      denied.audit_event_id = recordMeetingEvent(input, denied);
      traceCtx.endSpan('error', consent.reason);
      return { ...denied, ...finalizeActuatorTrace(traceCtx) };
    }
  }

  const bridgePath = path.resolve(
    pathResolver.rootResolve('libs/actuators/meeting-actuator/meeting-bridge.py')
  );
  logger.info(`[MEETING] Executing action: ${input.action} on ${input.params.platform}`);

  let parsed: MeetingActionResult;
  try {
    const raw = await retry(
      async () =>
        safeExec('python3', [bridgePath], {
          input: JSON.stringify(input),
        }),
      buildRetryOptions()
    );
    const normalized = String(raw).trim();
    if (!normalized) {
      parsed = { status: 'error', message: 'meeting-bridge produced no output' };
    } else {
      parsed = parseMeetingActionResult(
        parseSafeJsonInput(normalized, 'meeting bridge result')
      ) || {
        status: 'error',
        message: 'meeting-bridge produced an invalid result envelope',
      };
    }
  } catch (err: any) {
    parsed = {
      status: 'error',
      platform: input.params.platform,
      message: err?.message ?? String(err),
    };
  }

  traceCtx.endSpan(parsed.status === 'error' ? 'error' : 'ok', parsed.message);
  parsed.audit_event_id = recordMeetingEvent(input, parsed);
  return { ...parsed, ...finalizeActuatorTrace(traceCtx) };
}

const main = async () => {
  const argv = await createStandardYargs(process.argv)
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = resolveExistingMeetingFile(String(argv.input), 'input');
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(
    parseMeetingActionInput(parseSafeJsonInput(inputContent, 'meeting action input'))
  );
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && (modulePath === entrypoint || entrypoint.endsWith('index.js'))) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
