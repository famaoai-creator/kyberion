/**
 * Meeting session transport — join / leave / speak / listen / chat / status
 * plus voice-consent and audit. Extracted from meeting-actuator-helpers so
 * the transport seam is injectable (bridge runner / join driver) and the
 * intelligence ops can evolve independently.
 */
import { auditChain } from '@agent/core/governance/audit-chain';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { retry, getRetryDefaults } from '@agent/core/async-utils';
import { resolveIdentityContext } from '@agent/core/authority';
import {
  loadVoiceConsentAtPath,
  validateVoiceConsentRecord,
} from '@agent/core/voice/voice-consent';
import { parseSafeJsonInput, getRegisteredEnvText } from '@agent/core/foundation';
import * as path from 'node:path';
import { defineActuatorPipelineBase } from '@agent/core/actuator/actuator-sdk';
import { installMeetingParticipationDriver } from '@agent/core/meeting/meeting-driver-module-loader';
import { getMeetingJoinDriver } from '@agent/core/meeting/meeting-join-driver';
import type { MeetingPlatform, TranscriptChunk } from '@agent/core/meeting/meeting-session-types';
import { StubAudioBus } from '@agent/core/voice/audio-bus';
import { resolveAudioBus, type AudioBusId } from '@agent/core/voice/audio-bus-resolver';
import { extensionCaptionsToTranscript } from './extension-transcript.js';
import type { MeetingAction, MeetingActionResult } from './meeting-types.js';

const MEETING_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/meeting-actuator/manifest.json'
);

const { buildRetryOptions } = defineActuatorPipelineBase({
  manifestPath: MEETING_MANIFEST_PATH,
  retryDefaults: getRetryDefaults('meeting'),
  retryFallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

export { buildRetryOptions };

export function checkSpeakConsent(): { allowed: boolean; reason?: string } {
  if (getRegisteredEnvText('KYBERION_SUDO') === 'true') return { allowed: true };
  const missionId = getRegisteredEnvText('MISSION_ID');
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
    const consent = loadVoiceConsentAtPath(consentPath);
    return validateVoiceConsentRecord(consent, {
      missionId,
      tenantSlug: resolveIdentityContext().tenantSlug,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { allowed: false, reason: `failed to parse voice-consent.json: ${message}` };
  }
}

export function redactedTarget(input: MeetingAction): string {
  const url = input.params.url;
  if (!url) return `${input.params.platform}:no-url`;
  try {
    const u = new URL(url);
    return `${input.params.platform}:${u.host}${u.pathname.split('/').slice(0, 3).join('/')}`;
  } catch {
    return `${input.params.platform}:invalid-url`;
  }
}

export function recordMeetingEvent(input: MeetingAction, result: MeetingActionResult): string {
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[meeting] audit emission failed: ${message}`);
    return '';
  }
}

function resolveMeetingPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

/**
 * Run a registered MeetingJoinDriver, collect its optional transcript
 * stream, render the shared `[mm:ss] Speaker: text` transcript file.
 */
export async function runRegisteredJoinDriver(params: {
  driver_id?: string;
  url: string;
  platform?: string;
  display_name?: string;
  duration_sec?: number;
  transcript_path?: string;
  ws_port?: number;
  join_timeout_sec?: number;
  raise_hand?: boolean;
  audio_bridge?: string;
}): Promise<Record<string, unknown>> {
  const url = String(params.url || '').trim();
  if (!url) throw new Error('[meeting] extension join requires params.url');
  const platform = String(params.platform || 'auto').trim() || 'auto';
  const driverId = String(params.driver_id || 'chrome-extension').trim();
  if (!driverId) throw new Error('[meeting] join driver id must not be empty');
  const durationSec = Math.max(0, Number(params.duration_sec || 0));
  let driver = getMeetingJoinDriver(driverId);
  if (!driver) {
    await installMeetingParticipationDriver(driverId, {
      ...(params.ws_port !== undefined ? { extensionWsPort: Number(params.ws_port) } : {}),
      ...(params.join_timeout_sec !== undefined
        ? { extensionJoinTimeoutSec: Number(params.join_timeout_sec) }
        : {}),
    });
    driver = getMeetingJoinDriver(driverId);
  }
  if (!driver) throw new Error(`[meeting] '${driverId}' driver is not registered`);
  const probe = await driver.probe();
  if (!probe.available) {
    throw new Error(`[meeting] '${driverId}' driver unavailable: ${probe.reason || 'unknown'}`);
  }
  const audioBus =
    params.audio_bridge && params.audio_bridge !== 'none'
      ? resolveAudioBus(params.audio_bridge as AudioBusId)
      : new StubAudioBus();
  const session = await driver.join(
    {
      url,
      platform: platform as MeetingPlatform,
      display_name: String(params.display_name || 'Kyberion'),
    },
    audioBus
  );
  if (params.raise_hand && typeof session.raiseHand === 'function') {
    try {
      await session.raiseHand();
    } catch (err) {
      logger.warn(
        `[meeting] raise_hand after join failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const chunks: TranscriptChunk[] = [];
  const endAt = Date.now() + durationSec * 1000;
  const consumer = (async () => {
    if (typeof session.transcriptInput !== 'function') return;
    for await (const chunk of session.transcriptInput()) {
      if (typeof chunk.text === 'string' && chunk.text.trim()) chunks.push(chunk);
      if (Date.now() >= endAt) break;
    }
  })();
  try {
    while (Date.now() < endAt) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await session.leave().catch(() => undefined);
  }
  await Promise.race([
    consumer.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);

  const jsonl = chunks
    .map((chunk) =>
      JSON.stringify({
        text: chunk.text,
        ...(chunk.speaker_label ? { speaker: chunk.speaker_label } : {}),
        ts: chunk.emitted_at,
      })
    )
    .join('\n');
  const rendered = extensionCaptionsToTranscript(jsonl);
  const transcriptPath = String(params.transcript_path || '').trim();
  if (transcriptPath && rendered.cueCount > 0) {
    const resolved = resolveMeetingPath(transcriptPath);
    safeMkdir(path.dirname(resolved), { recursive: true });
    safeWriteFile(resolved, `${rendered.transcript}\n`);
  }
  return {
    status: 'success',
    platform,
    join_backend: driverId,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    caption_cues: rendered.cueCount,
    partial_state: rendered.cueCount === 0,
    ...(rendered.cueCount === 0
      ? { partial_reason: 'no live captions arrived from the extension' }
      : {}),
  };
}

export type BridgeRunner = (input: MeetingAction) => Promise<MeetingActionResult>;

/** Default Python-bridge transport. Injectable for tests / new backends. */
export async function runPythonBridge(input: MeetingAction): Promise<MeetingActionResult> {
  const bridgePath = path.resolve(
    pathResolver.rootResolve('libs/actuators/meeting-actuator/meeting-bridge.py')
  );
  logger.info(`[MEETING] Executing action: ${input.action} on ${input.params.platform}`);
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
      return { status: 'error', message: 'meeting-bridge produced no output' };
    }
    const parsed = parseMeetingActionResult(
      parseSafeJsonInput(normalized, 'meeting bridge result')
    );
    return (
      parsed || {
        status: 'error',
        message: 'meeting-bridge produced an invalid result envelope',
      }
    );
  } catch (err: unknown) {
    return {
      status: 'error',
      platform: input.params.platform,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-exported here so session transport owns the envelope boundary.
export function parseMeetingActionResult(value: unknown): MeetingActionResult | undefined {
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
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (!isPlainObject(value)) return undefined;
  if (value.status !== 'success' && value.status !== 'error' && value.status !== 'denied') {
    return undefined;
  }
  const result: MeetingActionResult = { status: value.status };
  const mutable = result as unknown as Record<string, unknown>;
  for (const field of MEETING_RESULT_STRING_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && typeof candidate !== 'string') return undefined;
    if (typeof candidate === 'string') mutable[field] = candidate;
  }
  for (const field of MEETING_RESULT_NUMBER_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && (typeof candidate !== 'number' || !Number.isFinite(candidate))) {
      return undefined;
    }
    if (typeof candidate === 'number') mutable[field] = candidate;
  }
  if (value.partial_state !== undefined && typeof value.partial_state !== 'boolean')
    return undefined;
  if (typeof value.partial_state === 'boolean') result.partial_state = value.partial_state;
  if (value.audit_event_id !== undefined && typeof value.audit_event_id !== 'string')
    return undefined;
  if (typeof value.audit_event_id === 'string') result.audit_event_id = value.audit_event_id;
  return result;
}
