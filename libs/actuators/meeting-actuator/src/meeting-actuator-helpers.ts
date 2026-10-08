/**
 * Meeting Actuator — orchestration layer.
 *
 * Transport (join / leave / speak / listen / chat / status + consent +
 * audit) lives in `meeting-session.ts`; intelligence / target / dialogue
 * ops live behind `meeting-op-dispatch.ts`. This module only owns:
 * input normalization (`{ action }` legacy, `{ op }` catalog, pipeline),
 * preflight + trace, and the ADF pipeline wiring.
 *
 * Guardrails (audit-load-bearing):
 *   1. Voice consent gate — `speak` refused without granted consent.
 *   2. Audit emission — every session action emits `meeting.<verb>`.
 *   3. Persona binding via the active identity context.
 */
import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { assertSafeRepositoryPath, safeLstat, safeExistsSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import { createActuatorTrace, finalizeActuatorTrace } from '@agent/core/actuator/actuator-trace';
import { runAdfActuatorPipeline } from '@agent/core/actuator/actuator-sdk';
import { resolveVars } from '@agent/core/logic-utils';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { nowIso, readJson } from '@agent/core/foundation';
import {
  createStandardYargs,
  currentProcessArgv,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { resolveMeetingProvider } from './meeting-provider-adapters.js';
import {
  checkSpeakConsent,
  parseMeetingActionResult,
  recordMeetingEvent,
  runPythonBridge,
  runRegisteredJoinDriver,
} from './meeting-session.js';
import {
  MEETING_ALL_SINGLE_OPS,
  dispatchMeetingIntelligenceOp,
  isMeetingIntelligenceOp,
  isMeetingSessionOp,
} from './meeting-op-dispatch.js';
import type {
  MeetingAction,
  MeetingActionResult,
  MeetingInput,
  MeetingOpAction,
  MeetingPipelineAction,
} from './meeting-types.js';

export type { MeetingAction, MeetingActionResult, MeetingPipelineAction } from './meeting-types.js';
export { checkSpeakConsent, parseMeetingActionResult };
export { MEETING_ALL_SINGLE_OPS };

type MeetingActuatorProvider = NonNullable<MeetingAction['params']['provider']>;
type MeetingActuatorPlatform = MeetingAction['params']['platform'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const MEETING_ACTIONS = new Set<string>([
  'check_consent',
  'join',
  'leave',
  'speak',
  'listen',
  'chat',
  'status',
]);

const MEETING_OPS = new Set<string>(MEETING_ALL_SINGLE_OPS);

/** Validate the structural CLI boundary before the typed handler runs. */
export function parseMeetingActionInput(value: unknown): MeetingInput {
  if (!isPlainObject(value)) {
    throw new Error('meeting action input must be an object with an action');
  }
  // Catalog-style single-op envelope: { op, params }.
  if (typeof value.op === 'string') {
    if (!MEETING_OPS.has(value.op)) {
      throw new Error(`meeting action input has unknown op: ${value.op}`);
    }
    const params = value.params ?? {};
    if (!isPlainObject(params)) {
      throw new Error('meeting action input params must be an object');
    }
    return { op: value.op, params } as MeetingOpAction;
  }
  if (typeof value.action !== 'string') {
    throw new Error('meeting action input must be an object with an action');
  }
  if (value.action === 'pipeline') {
    if (!Array.isArray((value as { steps?: unknown }).steps)) {
      throw new Error('meeting action input pipeline steps must be an array');
    }
    return value as unknown as MeetingPipelineAction;
  }
  if (isMeetingIntelligenceOp(value.action)) {
    if (value.params !== undefined && !isPlainObject(value.params)) {
      throw new Error('meeting action input params must be an object');
    }
    // Intelligence ops are also accepted as direct actions (not only
    // via pipeline steps) so SDK dispatch and CLI stay uniform.
    return {
      op: value.action,
      params: (value.params ?? {}) as Record<string, unknown>,
    } as MeetingOpAction;
  }
  if (!MEETING_ACTIONS.has(value.action)) {
    throw new Error(`meeting action input has unknown action: ${value.action}`);
  }
  if (!isPlainObject((value as { params?: unknown }).params)) {
    throw new Error('meeting action input params must be an object');
  }
  return value as unknown as MeetingAction;
}

function resolveExistingMeetingFile(ref: string, label: string): string {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(ref), {
    allowMissingLeaf: false,
  });
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`[MEETING_RESOURCE_FILE] ${label} must be a regular file: ${ref}`);
  }
  return resolved;
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
    context: { ...initialContext, timestamp: nowIso() } as Record<string, unknown>,
    options: {
      maxSteps: options.max_steps || DEFAULT_MAX_PIPELINE_STEPS,
      timeoutMs: options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS,
    },
    handlers: {
      capture: async (op, rawParams, context) => {
        if (op === 'check_consent') {
          const consent = checkSpeakConsent();
          return meetingExport(
            context,
            rawParams as Record<string, unknown>,
            {
              status: consent.allowed ? 'success' : 'denied',
              allowed: consent.allowed,
              ...(consent.reason ? { message: consent.reason } : {}),
            },
            'consent_result'
          );
        }
        // Pure ops are callable as capture (dry-run safe) or apply.
        if (op === 'resolve_next_target' || op === 'normalize_transcript') {
          const params = resolveMeetingParams(rawParams, context) as Record<string, unknown>;
          return meetingExport(
            context,
            params,
            await dispatchMeetingIntelligenceOp(op, params, context),
            op === 'resolve_next_target' ? 'meeting_target' : `${op}_result`
          );
        }
        if (op !== 'listen' && op !== 'status') {
          throw new Error(`[UNKNOWN_OP] Unknown meeting capture op: ${op}`);
        }
        const params = resolveMeetingParams(rawParams, context) as MeetingAction['params'];
        return meetingExport(
          context,
          params as Record<string, unknown>,
          await handleSessionAction({ action: op as 'listen' | 'status', params }),
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
        const params = resolveMeetingParams(rawParams, context) as Record<string, unknown>;
        // Session verbs run through the audited transport; everything
        // else shares the intelligence dispatch table.
        if (isMeetingSessionOp(op) && op !== 'check_consent') {
          return meetingExport(
            context,
            params,
            await handleSessionAction({
              action: op as MeetingAction['action'],
              params: params as unknown as MeetingAction['params'],
            }),
            `meeting_${op}_result`
          );
        }
        if (isMeetingIntelligenceOp(op)) {
          return meetingExport(
            context,
            params,
            await dispatchMeetingIntelligenceOp(op, params, context),
            op === 'resolve_next_target' ? 'meeting_target' : `${op}_result`
          );
        }
        throw new Error(`[UNKNOWN_OP] Unknown meeting op: ${op}`);
      },
    },
  });
  return result as unknown as Record<string, unknown>;
}

/** Session transport with provider resolution, consent gate, and audit. */
async function handleSessionAction(input: MeetingAction): Promise<MeetingActionResult> {
  const providerAdapter = resolveMeetingProvider(input.params.provider, input.params.url);
  if (providerAdapter && input.params.provider === 'auto') {
    input = {
      ...input,
      params: {
        ...input.params,
        provider: providerAdapter.executionProvider as MeetingActuatorProvider,
        platform: providerAdapter.platform as MeetingActuatorPlatform,
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

  // Explicit driver ids resolve through MeetingJoinDriver. `playwright`
  // keeps the established subprocess path; `auto` tries the operator's
  // Chrome and falls back to Playwright for unattended runs.
  if (input.action === 'join' || input.action === 'listen') {
    const requested = String(input.params.join_backend || 'playwright')
      .trim()
      .toLowerCase();
    const url = String(input.params.url || '').trim();
    if (url && requested !== 'playwright') {
      try {
        const extended = await runRegisteredJoinDriver({
          driver_id: requested === 'auto' ? 'chrome-extension' : requested,
          url,
          ...(input.params.platform ? { platform: String(input.params.platform) } : {}),
          ...(input.params.display_name ? { display_name: String(input.params.display_name) } : {}),
          ...(input.params.duration_sec !== undefined
            ? { duration_sec: Number(input.params.duration_sec) }
            : {}),
          ...(input.params.transcript_path
            ? { transcript_path: String(input.params.transcript_path) }
            : {}),
          ...(input.params.ws_port !== undefined ? { ws_port: Number(input.params.ws_port) } : {}),
          ...(requested === 'auto' ? { join_timeout_sec: 20 } : {}),
          ...(input.params.raise_hand !== undefined
            ? { raise_hand: Boolean(input.params.raise_hand) }
            : {}),
          ...(input.params.audio_bridge ? { audio_bridge: input.params.audio_bridge } : {}),
        });
        const done = {
          status: 'success',
          ...extended,
        } as MeetingActionResult;
        done.audit_event_id = recordMeetingEvent(input, done);
        traceCtx.endSpan('ok');
        return { ...done, ...finalizeActuatorTrace(traceCtx) };
      } catch (err) {
        if (requested !== 'auto') {
          const failed = {
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          } as MeetingActionResult;
          failed.audit_event_id = recordMeetingEvent(input, failed);
          traceCtx.endSpan('error', failed.message);
          return { ...failed, ...finalizeActuatorTrace(traceCtx) };
        }
        logger.warn(
          `[MEETING] chrome-extension join failed, falling back to playwright: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

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

  const parsed = await runPythonBridge(input);
  traceCtx.endSpan(parsed.status === 'error' ? 'error' : 'ok', parsed.message);
  parsed.audit_event_id = recordMeetingEvent(input, parsed);
  return { ...parsed, ...finalizeActuatorTrace(traceCtx) };
}

/** Direct single intelligence op with preflight (mirrors pipeline apply). */
async function handleIntelligenceOp(op: string, params: Record<string, unknown>): Promise<unknown> {
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `meeting:${op}`,
    params,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation meeting:${op} was not admitted.`}`
    );
  }
  return dispatchMeetingIntelligenceOp(op, preflight.input as Record<string, unknown>, {});
}

export async function handleAction(
  input: MeetingInput
): Promise<MeetingActionResult | Record<string, unknown>> {
  const normalized = parseMeetingActionInput(input) as MeetingInput;
  if ((normalized as MeetingPipelineAction).action === 'pipeline') {
    const pipeline = normalized as MeetingPipelineAction;
    return executeMeetingPipeline(pipeline.steps || [], pipeline.context || {}, pipeline.options);
  }
  if ((normalized as MeetingOpAction).op) {
    const single = normalized as MeetingOpAction;
    if (single.op === 'check_consent') {
      const consent = checkSpeakConsent();
      return {
        status: consent.allowed ? 'success' : 'denied',
        kind: 'voice_consent_check',
        allowed: consent.allowed,
        ...(consent.reason ? { message: consent.reason } : {}),
      };
    }
    if (isMeetingSessionOp(single.op)) {
      return handleSessionAction({
        action: single.op as MeetingAction['action'],
        params: (single.params ?? {}) as MeetingAction['params'],
      });
    }
    return (await handleIntelligenceOp(
      single.op,
      (single.params ?? {}) as Record<string, unknown>
    )) as Record<string, unknown>;
  }
  const action = normalized as MeetingAction;
  if (action.action === 'check_consent') {
    const consent = checkSpeakConsent();
    return {
      status: consent.allowed ? 'success' : 'denied',
      kind: 'voice_consent_check',
      allowed: consent.allowed,
      ...(consent.reason ? { message: consent.reason } : {}),
    };
  }
  if (isMeetingIntelligenceOp(action.action)) {
    return (await handleIntelligenceOp(
      action.action,
      (action.params ?? {}) as unknown as Record<string, unknown>
    )) as Record<string, unknown>;
  }
  return handleSessionAction(action);
}

const main = async () => {
  const argv = await createStandardYargs(currentProcessArgv())
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = resolveExistingMeetingFile(String(argv.input), 'input');
  const result = await handleAction(
    parseMeetingActionInput(readJson<unknown>(inputPath, { label: 'meeting action input' }))
  );
  // eslint-disable-next-line no-console -- CLI entry: stdout carries this command's JSON result
  console.log(JSON.stringify(result, null, 2));
};

if (
  isDirectEntry(import.meta.url, 'libs/actuators/meeting-actuator/src/meeting-actuator-helpers.ts')
) {
  void runActuatorCliEntryPoint(main, 'meeting-actuator');
}
