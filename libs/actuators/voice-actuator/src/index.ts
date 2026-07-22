import AjvModule from 'ajv';
import {
  collectVoiceSamples,
  compileSchemaFromPath,
  getVoiceSampleIngestionPolicy,
  getSpeechToTextBridges,
  getSpeechToTextCapabilities,
  normalizeSpeechToTextResult,
  getVoiceEngineRecord,
  getVoiceEngineRegistry,
  getVoiceProfileRecord,
  getVoiceProfileRegistry,
  getWritableVoiceProfileRegistryForTier,
  materializeVoiceProfileSampleRefs,
  getVoiceRuntimePolicy,
  getVoiceTtsLanguageConfig,
  logger,
  pathResolver,
  recordInteraction,
  resolveVars,
  listToolRuntimeInventory,
  recordVoiceSample,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeUnlink,
  safeRmSync,
  validateVoiceProfileRegistration,
  verifyVoiceTranscript,
  resolveVoicePath,
  VoiceGenerationRuntime,
  writeVoiceProfileRegistry,
  splitVoiceTextIntoChunks,
  createActuatorTrace,
  finalizeActuatorTrace,
  resolveVoiceEngineForPlatform,
  resolveVoiceBackend,
  createVoiceCapabilityBridge,
  BlackHoleAudioBus,
  StubAudioBus,
  createCoreAudioDeviceInventoryBridge,
  getStreamingSttBridge,
  installShellStreamingSttBridgeFromEnv,
  TtsLoopbackVerifier,
  type TtsLoopbackVerificationRequest,
  type TtsSource,
  type AudioChunk,
  type AudioFormat,
  checkMeetingParticipationConsent,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  performPlayback,
  renderNativeArtifact,
  resolvePythonBin,
  waitForVoiceJob,
  type VoiceArtifactFormat,
} from './voice-runtime-helpers.js';
import { registerVoiceLoopbackSttAdapter } from './voice-stt-backend-adapters.js';
import { runActuatorCli } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const voiceActionValidate = compileSchemaFromPath(
  ajv,
  pathResolver.rootResolve('schemas/voice-action.schema.json')
);

type VoiceAction =
  | { action: 'health'; params?: Record<string, unknown> }
  | { action: 'speak_local'; params: Record<string, unknown> }
  | { action: 'list_voices'; params: Record<string, unknown> }
  | { action: 'list_audio_routes'; params: Record<string, unknown> }
  | { action: 'probe_audio_route'; params: Record<string, unknown> }
  | { action: 'verify_tts_loopback'; params: Record<string, unknown> }
  | {
      action: 'record_voice_sample';
      request_id: string;
      sample_id: string;
      duration_sec: number;
      language?: string;
      prompt_text?: string;
      output_path?: string;
    }
  | {
      action: 'collect_voice_samples';
      request_id: string;
      profile_draft?: {
        profile_id: string;
        display_name: string;
        tier: 'personal' | 'confidential' | 'public';
        languages: string[];
        default_engine_id: string;
        notes?: string;
      };
      samples: Array<{ sample_id: string; path: string; language?: string; note?: string }>;
    }
  | {
      action: 'collect_and_register_voice_profile';
      request_id: string;
      profile: {
        profile_id: string;
        display_name: string;
        tier: 'personal' | 'confidential' | 'public';
        languages: string[];
        default_engine_id: string;
        notes?: string;
      };
      samples: Array<{ sample_id: string; path: string; language?: string; note?: string }>;
      policy?: { strict_personal_voice?: boolean };
    }
  | {
      action: 'register_voice_profile';
      request_id: string;
      profile: {
        profile_id: string;
        display_name: string;
        tier: 'personal' | 'confidential' | 'public';
        languages: string[];
        default_engine_id: string;
        notes?: string;
      };
      samples: Array<{ sample_id: string; path: string; language?: string }>;
      policy?: { strict_personal_voice?: boolean };
    }
  | Record<string, any>;

export async function handleSingleAction(input: VoiceAction) {
  if (input.action === 'health') {
    return voiceHealth(input as any);
  }
  if (input.action === 'speak_local') {
    return speakLocal((input as any).params || {});
  }
  if (input.action === 'list_voices') {
    return listVoices();
  }
  if (input.action === 'list_audio_routes') {
    return listAudioRoutes(extractActionParams(input));
  }
  if (input.action === 'probe_audio_route') {
    return probeAudioRoute(extractActionParams(input));
  }
  if (input.action === 'verify_tts_loopback') {
    return verifyTtsLoopback(extractActionParams(input));
  }
  if (input.action === 'transcribe') {
    const payload = (input as any).params
      ? { action: 'transcribe_voice_sample', ...((input as any).params || {}) }
      : { ...input, action: 'transcribe_voice_sample' };
    return transcribeVoiceSample(payload as any);
  }
  if (input.action === 'generate_voice') {
    return generateVoice(input);
  }
  if (input.action === 'record_voice_sample') {
    const payload = (input as any).params
      ? { action: 'record_voice_sample', ...((input as any).params || {}) }
      : input;
    if ((payload as any).dry_run) {
      const requestId = String((payload as any).request_id || '');
      const sampleId = String((payload as any).sample_id || 'sample');
      const outputPath = String(
        (payload as any).output_path ||
          pathResolver.sharedTmp(`voice-sample-recording/${requestId}/${sampleId}.wav`)
      );
      return {
        status: 'succeeded',
        action: 'record_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        output_path: outputPath,
        prompt_path: `${outputPath}.prompt.txt`,
        duration_sec: Number((payload as any).duration_sec || 0),
        backend: 'dry_run',
        dry_run: true,
      };
    }
    return recordVoiceSample(payload as any);
  }
  if (input.action === 'record_verify_repair_voice_sample') {
    const payload = (input as any).params
      ? { action: 'record_verify_repair_voice_sample', ...((input as any).params || {}) }
      : input;
    return recordVerifyRepairVoiceSample(payload as any);
  }
  if (input.action === 'collect_voice_samples') {
    const payload = (input as any).params
      ? { action: 'collect_voice_samples', ...((input as any).params || {}) }
      : input;
    return collectVoiceSamples(payload as any);
  }
  if (input.action === 'collect_and_register_voice_profile') {
    const payload = (input as any).params
      ? { action: 'collect_and_register_voice_profile', ...((input as any).params || {}) }
      : input;
    return collectAndRegisterVoiceProfile(payload as any);
  }
  if (input.action === 'register_voice_profile') {
    const payload = (input as any).params
      ? { action: 'register_voice_profile', ...((input as any).params || {}) }
      : input;
    return registerVoiceProfile(payload as any);
  }
  if (input.action === 'transcribe_voice_sample') {
    const payload = (input as any).params
      ? { action: 'transcribe_voice_sample', ...((input as any).params || {}) }
      : input;
    return transcribeVoiceSample(payload as any);
  }
  if ((input as any).action === 'record_interaction') {
    const p = (input as any).params ?? {};
    if (!p.person_slug || !p.org || !p.summary) {
      throw new Error('[VOICE] record_interaction requires person_slug, org, and summary');
    }
    const node = recordInteraction({
      personSlug: p.person_slug,
      org: p.org,
      source: 'voice-actuator',
      interaction: {
        at: new Date().toISOString(),
        summary: p.summary,
        channel: p.channel ?? 'voice',
        ...(p.tone_shifts ? { tone_shifts: p.tone_shifts } : {}),
      },
    });
    logger.info(
      `[VOICE] recorded interaction with ${p.org}/${p.person_slug} (${node.history.length} entries)`
    );
    return {
      status: 'interaction_recorded',
      person_slug: p.person_slug,
      org: p.org,
      history_length: node.history.length,
    };
  }
  throw new Error(`Unsupported voice action: ${String((input as any)?.action)}`);
}

async function voiceHealth(input: {
  action: 'health';
  params?: Record<string, unknown>;
}): Promise<any> {
  const requestedMode = String(input.params?.requested_mode || 'trial').trim() || 'trial';
  const toolRuntimes = listToolRuntimeInventory(requestedMode as any);
  const voiceEngineRegistry = getVoiceEngineRegistry();
  const activeEngines = voiceEngineRegistry.engines.filter((engine) => engine.status === 'active');
  const qwen3Engine =
    voiceEngineRegistry.engines.find((engine) => engine.engine_id === 'mlx_audio_qwen3') || null;
  const resolvedQwen3Engine = qwen3Engine
    ? resolveVoiceEngineForPlatform(qwen3Engine.engine_id)
    : null;
  const mlxAudioRuntime =
    toolRuntimes.items.find((item) => item.tool.tool_id === 'mlx_audio') || null;
  const mlxWhisperRuntime =
    toolRuntimes.items.find((item) => item.tool.tool_id === 'mlx_whisper') || null;

  return {
    status: 'succeeded',
    action: 'health',
    requested_mode: requestedMode,
    native_voice_capability: await createVoiceCapabilityBridge().probe(),
    voice_engine_registry: {
      version: voiceEngineRegistry.version,
      default_engine_id: voiceEngineRegistry.default_engine_id,
      active_engine_count: activeEngines.length,
      qwen3_engine: qwen3Engine
        ? {
            engine_id: qwen3Engine.engine_id,
            status: qwen3Engine.status,
            kind: qwen3Engine.kind,
            provider: qwen3Engine.provider,
            supported_artifact_formats: qwen3Engine.supports.artifact_formats,
            fallback_engine_id: qwen3Engine.fallback_engine_id || null,
            resolved_engine_id: resolvedQwen3Engine?.engine_id || null,
          }
        : null,
    },
    tool_runtimes: {
      version: toolRuntimes.version,
      default_tool_id: toolRuntimes.default_tool_id,
      items: {
        mlx_audio: mlxAudioRuntime
          ? {
              lifecycle_stage: mlxAudioRuntime.lifecycle_stage,
              selected_action: mlxAudioRuntime.selected_action,
              selected_backend: mlxAudioRuntime.selected_backend,
              installed: mlxAudioRuntime.installed,
              requires_install: mlxAudioRuntime.requires_install,
              managed_env_path: mlxAudioRuntime.managed_env_path,
              reason: mlxAudioRuntime.reason,
            }
          : null,
        mlx_whisper: mlxWhisperRuntime
          ? {
              lifecycle_stage: mlxWhisperRuntime.lifecycle_stage,
              selected_action: mlxWhisperRuntime.selected_action,
              selected_backend: mlxWhisperRuntime.selected_backend,
              installed: mlxWhisperRuntime.installed,
              requires_install: mlxWhisperRuntime.requires_install,
              managed_env_path: mlxWhisperRuntime.managed_env_path,
              reason: mlxWhisperRuntime.reason,
            }
          : null,
      },
    },
  };
}

async function recordVerifyRepairVoiceSample(input: {
  action: 'record_verify_repair_voice_sample';
  request_id: string;
  sample_id: string;
  duration_sec: number;
  language?: string;
  prompt_text: string;
  recording_countdown_sec?: number;
  prompt_display_hold_ms?: number;
  output_path: string;
  max_repair_attempts?: number;
  repair_duration_sec?: number;
  resume_session_path?: string;
  dry_run?: boolean;
}): Promise<any> {
  const requestId = String(input.request_id || '').trim();
  const sampleId = String(input.sample_id || '').trim();
  const promptText = String(input.prompt_text || '').trim();
  const outputPath = resolveVoicePath(String(input.output_path || '').trim(), 'recording-output');
  if (!requestId || !sampleId || !promptText || !outputPath) {
    throw new Error(
      'record_verify_repair_voice_sample requires request_id, sample_id, prompt_text, and output_path'
    );
  }

  if (input.dry_run) {
    return {
      status: 'succeeded',
      action: 'record_verify_repair_voice_sample',
      request_id: requestId,
      sample_id: sampleId,
      output_path: outputPath,
      training_path: outputPath,
      verification: { status: 'passed', dry_run: true },
      repair_attempts: [],
      dry_run: true,
    };
  }

  const sessionPath = input.resume_session_path
    ? resolveVoicePath(input.resume_session_path, 'transcript-output')
    : pathResolver.sharedTmp(`voice-sample-repairs/${requestId}/${sampleId}/session.json`);
  let initial: any;
  let initialTranscript: any;
  let initialVerification: any;
  let repairAttempts: Array<Record<string, unknown>> = [];
  let replacements: Array<{
    start_sec: number;
    end_sec: number;
    path: string;
    segment_id: string;
  }> = [];

  if (input.resume_session_path) {
    let session: any;
    try {
      session = JSON.parse(safeReadFile(sessionPath, { encoding: 'utf8' }) as string);
    } catch (error: any) {
      throw new Error(
        `voice repair session could not be resumed: ${error?.message || String(error)}`
      );
    }
    if (
      session.request_id !== requestId ||
      session.sample_id !== sampleId ||
      session.prompt_text !== promptText
    ) {
      throw new Error('voice repair session does not match request_id, sample_id, and prompt_text');
    }
    if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
      try {
        safeUnlink(sessionPath);
      } catch {
        /* best effort cleanup of expired sensitive state */
      }
      throw new Error('voice repair session expired; start a new recording session');
    }
    initial = session.initial_recording;
    initialTranscript = session.initial_transcript;
    initialVerification = session.verification;
    repairAttempts = Array.isArray(session.repair_attempts) ? session.repair_attempts : [];
    replacements = Array.isArray(session.replacements) ? session.replacements : [];
    logger.info(
      `[VOICE] ↩️ ${sampleId} の修復セッションを再開します。初回録音と確認を再実行しません。`
    );
  } else {
    initial = await recordVoiceSample({
      action: 'record_voice_sample',
      request_id: requestId,
      sample_id: sampleId,
      duration_sec: Number(input.duration_sec),
      language: input.language,
      prompt_text: promptText,
      recording_countdown_sec: input.recording_countdown_sec,
      prompt_display_hold_ms: input.prompt_display_hold_ms,
      output_path: outputPath,
    });
    if (initial.status !== 'succeeded' || !initial.output_path) {
      return {
        ...initial,
        action: 'record_verify_repair_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        verification: { status: 'blocked', reason: initial.reason || 'initial recording failed' },
        repair_attempts: [],
      };
    }

    try {
      logger.info(`[VOICE] 🔎 ${sampleId} のSTT確認中（タイムスタンプ付きバックエンドを優先）...`);
      initialTranscript = await transcribeVoiceSample({
        action: 'transcribe_voice_sample',
        audio_path: initial.output_path,
        language: input.language,
        write_sidecar: false,
        prefer_timestamps: true,
      });
    } catch (error: any) {
      cleanupVoiceArtifact(initial.output_path);
      return {
        ...initial,
        action: 'record_verify_repair_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        verification: { status: 'blocked', reason: 'stt_unavailable' },
        repair_attempts: [],
        status: 'blocked',
        reason: `STT確認を開始できませんでした: ${error?.message || String(error)}`,
        data_retention: { raw_audio: 'deleted', resume_session: 'not_created' },
      };
    }
    initialVerification = verifyVoiceTranscript(
      promptText,
      initialTranscript.transcript || '',
      initialTranscript.segments || []
    );
  }
  if (initialVerification.status === 'passed') {
    logger.info(`[VOICE] ✅ ${sampleId} STT確認OK。再録音は不要です。`);
    return {
      ...initial,
      action: 'record_verify_repair_voice_sample',
      training_path: initial.output_path,
      transcript: initialTranscript.transcript,
      stt_backend: initialTranscript.selected_backend,
      stt_capabilities: initialTranscript.selected_capabilities,
      verification: initialVerification,
      repair_attempts: [],
      data_retention: { training_audio: 'retained_until_profile_promotion' },
    };
  }

  const maxAttempts = Math.max(1, Math.floor(Number(input.max_repair_attempts) || 2));
  const repairDurationSec = Math.max(5, Math.min(15, Number(input.repair_duration_sec) || 7));
  const uniqueTimestampRanges = new Set(
    initialVerification.segment_matches.map((match: any) => `${match.start_sec}:${match.end_sec}`)
  );
  if (
    initialVerification.segment_matches.length < initialVerification.expected_segments.length ||
    uniqueTimestampRanges.size < initialVerification.expected_segments.length
  ) {
    cleanupVoiceArtifact(initial.output_path);
    return {
      ...initial,
      action: 'record_verify_repair_voice_sample',
      request_id: requestId,
      sample_id: sampleId,
      transcript: initialTranscript.transcript,
      stt_backend: initialTranscript.selected_backend,
      stt_capabilities: initialTranscript.selected_capabilities,
      verification: initialVerification,
      repair_attempts: [],
      status: 'blocked',
      reason:
        'タイムスタンプ付きSTTで文の位置を特定できないため、安全な部分置換を実行できません。STT設定を確認してから再試行してください。',
      data_retention: { raw_audio: 'deleted', resume_session: 'not_created' },
    };
  }

  safeMkdir(path.dirname(sessionPath), { recursive: true });
  const persistRepairSession = (): void =>
    safeWriteFile(
      sessionPath,
      JSON.stringify(
        {
          version: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          request_id: requestId,
          sample_id: sampleId,
          prompt_text: promptText,
          initial_recording: initial,
          initial_transcript: initialTranscript,
          verification: initialVerification,
          repair_attempts: repairAttempts,
          replacements,
          next_action:
            'record only the listed mismatched segments, then rerun with resume_session_path',
        },
        null,
        2
      )
    );
  persistRepairSession();

  for (const [mismatchIndex, mismatch] of initialVerification.mismatches.entries()) {
    let repaired = replacements.some(
      (replacement) => replacement.segment_id === mismatch.segment_id
    );
    const previousAttempts = repairAttempts.filter(
      (attempt) => attempt.segment_id === mismatch.segment_id
    ).length;
    for (let attempt = previousAttempts + 1; attempt <= maxAttempts && !repaired; attempt += 1) {
      const repairPath = pathResolver.sharedTmp(
        `voice-sample-repairs/${requestId}/${sampleId}/${mismatch.segment_id}-attempt-${attempt}.wav`
      );
      logger.warn(
        `[VOICE] ⚠️ ${sampleId} 修復 ${mismatchIndex + 1}/${initialVerification.mismatches.length} ` +
          `${mismatch.segment_id} が不一致。` +
          `この文だけ再録音します (${attempt}/${maxAttempts})。\n原稿: 「${mismatch.text}」`
      );
      const repair = await recordVoiceSample({
        action: 'record_voice_sample',
        request_id: `${requestId}-repair-${mismatch.segment_id}-${attempt}`,
        sample_id: `${sampleId}-${mismatch.segment_id}`,
        duration_sec: repairDurationSec,
        language: input.language,
        prompt_text: mismatch.text,
        recording_countdown_sec: input.recording_countdown_sec,
        prompt_display_hold_ms: input.prompt_display_hold_ms,
        output_path: repairPath,
      });
      if (repair.status !== 'succeeded' || !repair.output_path) {
        repairAttempts.push({
          segment_id: mismatch.segment_id,
          attempt,
          status: 'blocked',
          reason: repair.reason || 'repair recording failed',
        });
        persistRepairSession();
        continue;
      }

      let repairTranscript: any;
      try {
        repairTranscript = await transcribeVoiceSample({
          action: 'transcribe_voice_sample',
          audio_path: repair.output_path,
          language: input.language,
          write_sidecar: false,
          prefer_timestamps: true,
        });
      } catch (error: any) {
        repairAttempts.push({
          segment_id: mismatch.segment_id,
          attempt,
          status: 'blocked',
          reason: `STT確認に失敗: ${error?.message || String(error)}`,
        });
        cleanupVoiceArtifact(repair.output_path);
        persistRepairSession();
        continue;
      }
      const repairVerification = verifyVoiceTranscript(
        mismatch.text,
        repairTranscript.transcript || '',
        repairTranscript.segments || []
      );
      logger.info(
        `[VOICE] ${sampleId}/${mismatch.segment_id} STT結果: ` +
          `${repairVerification.status}\n原稿: 「${mismatch.text}」\n認識: 「${repairTranscript.transcript || '(空)'}」`
      );
      repairAttempts.push({
        segment_id: mismatch.segment_id,
        attempt,
        status: repairVerification.status,
        expected: mismatch.text,
        transcript: repairTranscript.transcript,
        stt_backend: repairTranscript.selected_backend,
        stt_capabilities: repairTranscript.selected_capabilities,
      });
      persistRepairSession();
      if (repairVerification.status === 'passed') {
        const originalRange = initialVerification.segment_matches.find(
          (match) => match.segment_id === mismatch.segment_id
        );
        if (!originalRange) {
          cleanupVoiceArtifact(repair.output_path);
          return {
            ...initial,
            action: 'record_verify_repair_voice_sample',
            request_id: requestId,
            sample_id: sampleId,
            transcript: initialTranscript.transcript,
            stt_backend: initialTranscript.selected_backend,
            stt_capabilities: initialTranscript.selected_capabilities,
            verification: initialVerification,
            repair_attempts: repairAttempts,
            resume_session_path: sessionPath,
            status: 'blocked',
            reason: `${mismatch.segment_id} の元音声区間を特定できないため、部分置換を中止しました`,
          };
        }
        replacements.push({
          start_sec: originalRange.start_sec,
          end_sec: originalRange.end_sec,
          path: repair.output_path,
          segment_id: mismatch.segment_id,
        });
        persistRepairSession();
        repaired = true;
        break;
      }
      cleanupVoiceArtifact(repair.output_path);
    }
    if (!repaired) {
      return {
        ...initial,
        action: 'record_verify_repair_voice_sample',
        request_id: requestId,
        sample_id: sampleId,
        transcript: initialTranscript.transcript,
        stt_backend: initialTranscript.selected_backend,
        stt_capabilities: initialTranscript.selected_capabilities,
        training_path: undefined,
        verification: initialVerification,
        repair_attempts: repairAttempts,
        resume_session_path: sessionPath,
        status: 'blocked',
        reason: `${mismatch.segment_id} could not be verified after ${maxAttempts} repair attempt(s)`,
        data_retention: {
          raw_audio: 'retained_for_resume',
          failed_repair_audio: 'deleted_after_verification',
          resume_session: 'retained',
        },
      };
    }
  }

  const trainingPath = spliceVoiceRepairSegments(
    initial.output_path,
    replacements,
    pathResolver.sharedTmp(`voice-sample-repairs/${requestId}/${sampleId}/training-sample.wav`),
    promptText,
    initialTranscript.transcript
  );
  cleanupVoiceArtifact(initial.output_path);
  for (const replacement of replacements) cleanupVoiceArtifact(replacement.path);
  try {
    safeUnlink(sessionPath);
  } catch {
    logger.warn(`[VOICE] cleanup skipped for repair session ${sessionPath}`);
  }
  logger.info(`[VOICE] ✅ ${sampleId} のズレた文だけ再録音し、STT確認を通過しました。`);
  return {
    ...initial,
    action: 'record_verify_repair_voice_sample',
    request_id: requestId,
    sample_id: sampleId,
    training_path: trainingPath,
    transcript: initialTranscript.transcript,
    stt_backend: initialTranscript.selected_backend,
    stt_capabilities: initialTranscript.selected_capabilities,
    verification: {
      ...initialVerification,
      status: 'repaired',
      repaired_segments: initialVerification.mismatches.map((segment) => segment.segment_id),
    },
    repair_attempts: repairAttempts,
    data_retention: {
      raw_audio: 'deleted_after_splice',
      repair_audio: 'deleted_after_splice',
      training_audio: 'retained_until_profile_promotion',
      resume_session: 'deleted_after_success',
    },
  };
}

function cleanupVoiceArtifact(filePath: string | undefined): void {
  if (!filePath) return;
  for (const candidate of [filePath, `${filePath}.prompt.txt`, `${filePath}.transcript.txt`]) {
    try {
      if (safeExistsSync(candidate)) safeUnlink(candidate);
    } catch {
      logger.warn(`[VOICE] cleanup skipped for ${candidate}`);
    }
  }
}

function spliceVoiceRepairSegments(
  originalPath: string,
  replacements: Array<{ start_sec: number; end_sec: number; path: string; segment_id: string }>,
  outputPath: string,
  expectedTranscript: string,
  sttTranscript: string
): string {
  if (replacements.length === 0) throw new Error('voice repair produced no verified segments');
  const sorted = [...replacements].sort((left, right) => left.start_sec - right.start_sec);
  safeMkdir(path.dirname(outputPath), { recursive: true });
  const inputs = ['-i', originalPath, ...sorted.flatMap((replacement) => ['-i', replacement.path])];
  const filters: string[] = [];
  const labels: string[] = [];
  let cursor = 0;
  let outputIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const replacement = sorted[index];
    const start = Math.max(cursor, replacement.start_sec);
    const end = Math.max(start, replacement.end_sec);
    if (end <= start) continue;
    if (start > cursor) {
      const label = `[part${outputIndex}]`;
      filters.push(`[0:a]atrim=start=${cursor}:end=${start},asetpts=PTS-STARTPTS${label}`);
      labels.push(label);
      outputIndex += 1;
    }
    const replacementLabel = `[part${outputIndex}]`;
    filters.push(
      `[${index + 1}:a]aformat=sample_rates=16000:channel_layouts=mono,asetpts=PTS-STARTPTS${replacementLabel}`
    );
    labels.push(replacementLabel);
    outputIndex += 1;
    cursor = end;
  }
  filters.push(`[0:a]atrim=start=${cursor},asetpts=PTS-STARTPTS[part${outputIndex}]`);
  labels.push(`[part${outputIndex}]`);
  const filter = `${filters.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`;
  safeExec('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
  safeWriteFile(`${outputPath}.transcript.txt`, `${expectedTranscript}\n`);
  safeWriteFile(`${outputPath}.stt.transcript.txt`, `${sttTranscript}\n`);
  return outputPath;
}

async function collectAndRegisterVoiceProfile(input: {
  action: 'collect_and_register_voice_profile';
  request_id: string;
  profile: {
    profile_id: string;
    display_name: string;
    tier: 'personal' | 'confidential' | 'public';
    languages: string[];
    default_engine_id: string;
    notes?: string;
  };
  samples: Array<{ sample_id: string; path: string; language?: string; note?: string }>;
  policy?: { strict_personal_voice?: boolean; allow_update?: boolean };
  dry_run?: boolean;
}): Promise<any> {
  if (input.dry_run) {
    const collectionDir = pathResolver.sharedTmp(`voice-sample-collection/${input.request_id}`);
    return {
      status: 'succeeded',
      action: 'collect_and_register_voice_profile',
      request_id: input.request_id,
      dry_run: true,
      collection: {
        status: 'dry_run',
        request_id: input.request_id,
        collection_manifest_path: path.join(collectionDir, 'collection-manifest.json'),
        collection_dir: collectionDir,
        staged_samples: [],
        summary: {
          sample_count: 0,
          total_sample_bytes: 0,
          collection_dir: collectionDir,
        },
        registration_candidate: {
          action: 'register_voice_profile',
          request_id: input.request_id,
          profile: input.profile,
          samples: [],
        },
      },
      registration: {
        status: 'dry_run',
        action: 'register_voice_profile',
        request_id: input.request_id,
        profile_id: input.profile.profile_id,
        sample_refs: [],
        summary: {
          sample_count: 0,
          total_sample_bytes: 0,
          strict_personal_voice: Boolean(input.policy?.strict_personal_voice),
        },
      },
    };
  }
  const collected = collectVoiceSamples({
    action: 'collect_voice_samples',
    request_id: input.request_id,
    profile_draft: input.profile,
    samples: input.samples,
  });
  const registration = await registerVoiceProfile({
    action: 'register_voice_profile',
    request_id: input.request_id,
    profile: input.profile,
    samples: collected.registration_candidate.samples,
    policy: input.policy,
  });
  return {
    status: registration.status === 'succeeded' ? 'succeeded' : registration.status,
    action: 'collect_and_register_voice_profile',
    request_id: input.request_id,
    collection: collected,
    registration,
  };
}

export async function handleAction(input: VoiceAction) {
  validateVoiceAction(input);
  if ((input as any).action === 'pipeline') {
    const traceCtx = createActuatorTrace('voice-actuator', 'pipeline', {
      pipelineId: String((input as any).request_id || ''),
    });
    traceCtx.startSpan('voice:pipeline', {
      stepCount: Array.isArray((input as any).steps) ? (input as any).steps.length : 0,
    });
    const results = [];
    try {
      for (const step of (input as any).steps) {
        validateVoiceAction(step);
        traceCtx.startSpan(`voice:${String(step.action || 'step')}`);
        try {
          results.push(await handleSingleAction(step));
          traceCtx.endSpan('ok');
        } catch (err: any) {
          traceCtx.endSpan('error', err?.message ?? String(err));
          throw err;
        }
      }
      traceCtx.endSpan('ok');
      return { status: 'succeeded', results, ...finalizeActuatorTrace(traceCtx) };
    } catch (err: any) {
      traceCtx.endSpan('error', err?.message ?? String(err));
      return {
        status: 'error',
        message: err?.message ?? String(err),
        results,
        ...finalizeActuatorTrace(traceCtx),
      };
    }
  }
  const traceCtx = createActuatorTrace(
    'voice-actuator',
    String((input as any).action || 'unknown')
  );
  traceCtx.startSpan(`voice:${String((input as any).action || 'unknown')}`);
  try {
    const result = await handleSingleAction(input);
    traceCtx.endSpan('ok');
    return { ...result, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'error',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

function validateVoiceAction(input: unknown): void {
  const ok = voiceActionValidate(input);
  if (ok) return;
  const detail = (voiceActionValidate.errors || [])
    .map((error: any) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`Invalid voice action: ${detail}`);
}

async function listVoices(): Promise<any> {
  const engine = resolveVoiceEngineForPlatform();
  if (!engine.supports.list_voices) {
    return { status: 'succeeded', voices: [], engine_id: engine.engine_id };
  }

  if (process.platform === 'darwin') {
    const output = safeExec('say', ['-v', '?']);
    const voices = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const voice = line.split(/\s+/)[0];
        return { id: voice, display_name: voice, provider: 'say' };
      });
    return { status: 'succeeded', voices, engine_id: engine.engine_id };
  }

  if (process.platform === 'linux') {
    return {
      status: 'succeeded',
      voices: [{ id: 'espeak-default', display_name: 'espeak default', provider: 'espeak' }],
      engine_id: engine.engine_id,
    };
  }

  if (process.platform === 'win32') {
    return {
      status: 'succeeded',
      voices: [
        { id: 'windows-default', display_name: 'Windows Speech Synthesizer', provider: 'sapi' },
      ],
      engine_id: engine.engine_id,
    };
  }

  return { status: 'succeeded', voices: [], engine_id: engine.engine_id };
}

async function listAudioRoutes(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestedBus = stringParam(params, 'bus') || 'blackhole';
  if (requestedBus === 'stub') {
    return {
      status: 'succeeded',
      action: 'list_audio_routes',
      platform: process.platform,
      routes: [{ bus_id: 'stub', available: true }],
    };
  }
  if (requestedBus !== 'blackhole')
    throw new Error(`unsupported audio route bus '${requestedBus}'`);
  const inventory = await createCoreAudioDeviceInventoryBridge().probe();
  const viewModel = buildAudioRouteViewModel(
    inventory.devices,
    inventory.available,
    inventory.reason
  );
  return {
    status: 'succeeded',
    action: 'list_audio_routes',
    platform: process.platform,
    routes: [
      {
        bus_id: 'blackhole',
        available: inventory.available,
        ...(inventory.reason ? { reason: inventory.reason } : {}),
        devices: inventory.devices,
      },
    ],
    view_model: viewModel,
  };
}

async function probeAudioRoute(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const busId = stringParam(params, 'bus') || 'blackhole';
  if (busId === 'stub')
    return {
      status: 'succeeded',
      action: 'probe_audio_route',
      probe: await new StubAudioBus().probe(),
      view_model: buildAudioRouteViewModel([], true, 'stub route'),
    };
  if (busId !== 'blackhole') throw new Error(`unsupported audio route bus '${busId}'`);
  const bus = new BlackHoleAudioBus({
    ...(stringParam(params, 'input_device_uid')
      ? { input_device_uid: stringParam(params, 'input_device_uid') }
      : {}),
    ...(stringParam(params, 'output_device_uid')
      ? { output_device_uid: stringParam(params, 'output_device_uid') }
      : {}),
    ...(stringParam(params, 'expected_device_label')
      ? { expected_device_label: stringParam(params, 'expected_device_label') }
      : {}),
  });
  const probe = await bus.probe();
  return {
    status: 'succeeded',
    action: 'probe_audio_route',
    probe,
    view_model: buildAudioRouteViewModel(
      probe.device_descriptors ?? [],
      probe.available,
      probe.reason
    ),
  };
}

function buildAudioRouteViewModel(
  devices: readonly { uid: string; display_name: string; direction: string; is_virtual: boolean }[],
  available: boolean,
  reason?: string
): Record<string, unknown> {
  return {
    screen: 'audio-route-setup',
    status: available ? 'ready' : 'blocked',
    status_text: available ? '経路を検証できます' : '経路を確認してください',
    steps: [
      {
        id: 'driver',
        label: 'BlackHole 2ch インストール状態',
        status: available ? 'pass' : 'action_required',
      },
      {
        id: 'input',
        label: '入力device（UID優先）',
        status: devices.some(
          (device) => device.direction === 'input' || device.direction === 'duplex'
        )
          ? 'pass'
          : 'action_required',
      },
      {
        id: 'output',
        label: '出力device（UID優先）',
        status: devices.some(
          (device) => device.direction === 'output' || device.direction === 'duplex'
        )
          ? 'pass'
          : 'action_required',
      },
      { id: 'consent', label: '音声出力consent', status: 'operator_confirmation_required' },
      { id: 'test', label: 'テスト文言を確認して開始', status: available ? 'ready' : 'blocked' },
    ],
    devices: devices.map((device) => ({
      uid: device.uid,
      uid_suffix: device.uid.slice(-8),
      display_name: device.display_name,
      direction: device.direction,
      virtual: device.is_virtual,
    })),
    physical_output_default: false,
    emergency_stop_available: true,
    ...(reason ? { reason } : {}),
  };
}

async function verifyTtsLoopback(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const requestId = stringParam(params, 'request_id') || '';
  const text = stringParam(params, 'text') || '';
  const language = stringParam(params, 'language') || 'ja';
  const profileId =
    stringParam(params, 'voice_profile_id') || getVoiceProfileRegistry().default_profile_id;
  const route = recordParam(params, 'audio_route');
  const busId = stringParam(route, 'bus') || 'blackhole';
  if (busId !== 'blackhole' && busId !== 'stub')
    throw new Error(`unsupported audio route bus '${busId}'`);
  const dryRun = booleanParam(params, 'dry_run');
  const bus =
    busId === 'stub'
      ? new StubAudioBus()
      : new BlackHoleAudioBus({
          ...(stringParam(route, 'input_device_uid')
            ? { input_device_uid: stringParam(route, 'input_device_uid') }
            : {}),
          ...(stringParam(route, 'output_device_uid')
            ? { output_device_uid: stringParam(route, 'output_device_uid') }
            : {}),
          ...(stringParam(route, 'expected_device_label')
            ? { expected_device_label: stringParam(route, 'expected_device_label') }
            : {}),
          session_id: requestId,
        });
  const request = buildLoopbackRequest(
    params,
    requestId,
    text,
    language,
    profileId,
    busId as 'blackhole' | 'stub',
    dryRun
  );
  const sttBridgeId = stringParam(params, 'stt_bridge_id');
  registerVoiceLoopbackSttAdapter(sttBridgeId, { request_id: requestId, language });
  if (sttBridgeId === 'shell' || process.env.KYBERION_STREAMING_STT_BRIDGE === 'shell') {
    const installation = installShellStreamingSttBridgeFromEnv();
    if (!installation.installed) {
      throw new Error(`streaming STT shell bridge unavailable: ${installation.reason}`);
    }
  }
  const stt =
    busId === 'stub' && !sttBridgeId
      ? createDeterministicLoopbackStt(text)
      : getStreamingSttBridge(sttBridgeId);
  const consent = (): { allowed: boolean; reason?: string } => {
    if (dryRun) return { allowed: true };
    const missionId = stringParam(params, 'mission_id');
    if (missionId) {
      const consentResult = checkMeetingParticipationConsent({
        mission_id: missionId,
        tenant_slug: stringParam(params, 'tenant_slug'),
        purpose: 'voice',
      });
      return consentResult;
    }
    return booleanParam(params, 'operator_confirmed')
      ? { allowed: true }
      : {
          allowed: false,
          reason: 'operator_confirmed=true or mission-scoped voice consent is required',
        };
  };
  const verifier = new TtsLoopbackVerifier({
    bus,
    tts:
      busId === 'stub'
        ? createDeterministicLoopbackTts()
        : createNativeArtifactTtsSource({ requestId, language, profileId }),
    stt,
    checkConsent: consent,
  });
  const receipt = await verifier.verify(request);
  return { ...receipt, action: 'verify_tts_loopback' };
}

function createDeterministicLoopbackTts(): TtsSource {
  const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };
  return {
    bridge_id: 'deterministic-loopback-tts',
    async *synthesize(_text: string) {
      const payload = new Uint8Array((format.sample_rate_hz / 10) * 2);
      const view = new DataView(payload.buffer);
      for (let index = 0; index < payload.byteLength; index += 2) {
        view.setInt16(index, Math.round(Math.sin(index / 7) * 2_000), true);
      }
      yield { format, payload, ts_ms: 0 };
    },
  };
}

function createDeterministicLoopbackStt(expectedText: string): {
  readonly bridge_id: string;
  transcribeStream(audio: AsyncIterable<AudioChunk>): AsyncIterable<{
    utterance_id: string;
    is_final: boolean;
    text: string;
    confidence: number;
    emitted_at: string;
  }>;
} {
  return {
    bridge_id: 'deterministic-loopback-stt',
    async *transcribeStream(audio) {
      let chunks = 0;
      for await (const _chunk of audio) chunks += 1;
      if (chunks > 0) {
        yield {
          utterance_id: 'deterministic-loopback-utterance',
          is_final: true,
          text: expectedText,
          confidence: 1,
          emitted_at: new Date().toISOString(),
        };
      }
    },
  };
}

function buildLoopbackRequest(
  params: Record<string, unknown>,
  requestId: string,
  text: string,
  language: string,
  profileId: string,
  bus: 'blackhole' | 'stub',
  dryRun: boolean
): TtsLoopbackVerificationRequest {
  const route = recordParam(params, 'audio_route');
  const format = recordParam(params, 'format');
  const timing = recordParam(params, 'timing');
  const quality = recordParam(params, 'quality');
  const persistence = recordParam(params, 'persistence');
  return {
    request_id: requestId,
    ...(stringParam(params, 'mission_id') ? { mission_id: stringParam(params, 'mission_id') } : {}),
    ...(stringParam(params, 'tenant_slug')
      ? { tenant_slug: stringParam(params, 'tenant_slug') }
      : {}),
    text,
    ...(stringParam(params, 'expected_text')
      ? { expected_text: stringParam(params, 'expected_text') }
      : {}),
    language,
    voice_profile_id: profileId,
    audio_route: {
      bus,
      ...(stringParam(route, 'input_device_uid')
        ? { input_device_uid: stringParam(route, 'input_device_uid') }
        : {}),
      ...(stringParam(route, 'output_device_uid')
        ? { output_device_uid: stringParam(route, 'output_device_uid') }
        : {}),
      ...(stringParam(route, 'expected_device_label')
        ? { expected_device_label: stringParam(route, 'expected_device_label') }
        : {}),
    },
    ...(format
      ? {
          format: {
            encoding: 'pcm_s16le',
            sample_rate_hz: numberParam(format, 'sample_rate_hz', 16_000) as
              | 16_000
              | 24_000
              | 48_000,
            channels: numberParam(format, 'channels', 1) as 1 | 2,
          },
        }
      : {}),
    ...(timing ? { timing: numericRecord(timing) } : {}),
    ...(quality ? { quality: numericRecord(quality) } : {}),
    ...(persistence
      ? {
          persistence: {
            retain_audio: booleanParam(persistence, 'retain_audio'),
            retain_transcript: booleanParam(persistence, 'retain_transcript'),
            ...(stringParam(persistence, 'output_dir')
              ? { output_dir: stringParam(persistence, 'output_dir') }
              : {}),
          },
        }
      : {}),
    dry_run: dryRun,
  };
}

function createNativeArtifactTtsSource(options: {
  requestId: string;
  language: string;
  profileId: string;
}): TtsSource {
  return {
    bridge_id: 'voice-engine-artifact-to-pcm',
    async *synthesize(text, voiceProfileId) {
      const profile = getVoiceProfileRecord(voiceProfileId || options.profileId);
      const defaults = getVoiceTtsLanguageConfig(options.language);
      const engine = resolveVoiceEngineForPlatform(profile.default_engine_id);
      const artifactFormats = engine.supports.artifact_formats;
      const artifactFormat =
        process.platform === 'darwin' &&
        engine.engine_id === 'local_say' &&
        artifactFormats.includes('aiff')
          ? 'aiff'
          : artifactFormats.includes('wav')
            ? 'wav'
            : (artifactFormats[0] ?? 'wav');
      const artifact = await renderNativeArtifact(text, {
        requestId: options.requestId,
        voice: defaults.voice,
        rate: defaults.rate,
        language: options.language,
        format: artifactFormat,
        engineId: engine.engine_id,
        supportsFormats: engine.supports.artifact_formats,
        profile,
      });
      const rawPath = pathResolver.sharedTmp(`voice-loopback/${options.requestId}.pcm`);
      safeMkdir(path.dirname(rawPath), { recursive: true });
      try {
        safeExec('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          artifact,
          '-f',
          's16le',
          '-ac',
          '1',
          '-ar',
          '16000',
          rawPath,
        ]);
        const raw = Buffer.from(safeReadFile(rawPath, { encoding: null }) as Buffer);
        const chunkBytes = 640;
        for (let offset = 0; offset < raw.byteLength; offset += chunkBytes) {
          const payload = new Uint8Array(
            raw.subarray(offset, Math.min(raw.byteLength, offset + chunkBytes))
          );
          if (payload.byteLength % 2 !== 0) continue;
          yield {
            format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
            payload,
            ts_ms: offset / 32,
          };
        }
      } finally {
        safeRmSync(rawPath, { force: true });
        safeRmSync(artifact, { force: true });
      }
    },
  };
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  return typeof params[key] === 'number' && Number.isFinite(params[key])
    ? (params[key] as number)
    : fallback;
}

function recordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(params[key]) ? params[key] : {};
}

function numericRecord(params: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value)
    )
  ) as Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractActionParams(input: VoiceAction): Record<string, unknown> {
  const value = input as unknown as Record<string, unknown>;
  if (isRecord(value.params)) return value.params;
  const { action: _action, ...params } = value;
  return params;
}

async function speakLocal(params: Record<string, unknown>): Promise<any> {
  const text = String(params.text || '').trim();
  if (!text) throw new Error('speak_local requires params.text');

  const language =
    String(params.language || '')
      .trim()
      .toLowerCase() || 'en';
  const defaults = getVoiceTtsLanguageConfig(language);
  const voice =
    typeof params.voice === 'string' && params.voice.trim() ? params.voice.trim() : defaults.voice;
  const rate = Number.isFinite(params.rate) ? Number(params.rate) : defaults.rate;
  const requestedEngineId = String(params.engine_id || 'local_say').trim() || 'local_say';
  const engine = resolveVoiceEngineForPlatform(requestedEngineId);
  const backend = resolveVoiceBackend(requestedEngineId);

  const playback = await performPlayback(text, {
    language,
    voice,
    rate,
    engineId: engine.engine_id,
  });
  return {
    status: 'succeeded',
    mode: 'speaker_verification',
    engine: engine.kind,
    engine_id: requestedEngineId,
    resolved_engine_id: engine.engine_id,
    backend_id: backend.backend_id,
    backend_kind: backend.kind,
    backend_provider: backend.provider,
    language,
    voice,
    rate,
    speaker_verification: playback,
  };
}

async function generateVoice(input: Record<string, any>): Promise<any> {
  if (input.dry_run) {
    const jobId = String(input.request_id || randomUUID());
    const artifactPath = String(
      input.delivery?.artifact_path || pathResolver.sharedTmp(`voice-out/${jobId}/generated.wav`)
    );
    return {
      status: 'succeeded',
      request_id: jobId,
      profile_id: String(input.profile_ref?.profile_id || 'dry-run-profile'),
      language: String(input.rendering?.language || 'ja').toLowerCase(),
      engine_id: String(input.engine?.engine_id || 'dry_run'),
      resolved_engine_id: String(input.engine?.engine_id || 'dry_run'),
      backend_id: 'dry_run',
      backend_kind: 'dry_run',
      backend_provider: 'dry_run',
      chunks: 0,
      progress_packets: [],
      artifact_refs: [artifactPath],
      speaker_verification: [],
      delivery_mode: String(input.delivery?.mode || 'artifact'),
      format: String(input.delivery?.format || 'wav'),
      dry_run: true,
    };
  }
  const profile = getVoiceProfileRecord(input.profile_ref?.profile_id);
  const policy = getVoiceRuntimePolicy();
  const jobId = String(input.request_id || randomUUID());
  const language = String(input.rendering?.language || profile.languages[0] || 'en').toLowerCase();
  const defaults = getVoiceTtsLanguageConfig(language);
  const maxChunkChars = Number(
    input.rendering?.chunking?.max_chunk_chars || policy.chunking.default_max_chunk_chars
  );
  const crossfadeMs = Number(
    input.rendering?.chunking?.crossfade_ms || policy.chunking.default_crossfade_ms
  );
  const chunks = splitVoiceTextIntoChunks(String(input.text || ''), maxChunkChars);
  const deliveryMode = String(input.delivery?.mode || 'playback');
  const requestedFormat = String(
    input.delivery?.format || policy.delivery.default_format
  ) as VoiceArtifactFormat;
  const requestedEngineId =
    String(input.engine?.engine_id || profile.default_engine_id || '').trim() ||
    profile.default_engine_id;
  const defaultEngine = getVoiceEngineRecord(profile.default_engine_id);
  const engine = resolveVoiceEngineForPlatform(requestedEngineId);
  const backend = resolveVoiceBackend(requestedEngineId);
  const personalVoiceMode = String(
    input.routing?.personal_voice_mode || policy.routing.default_personal_voice_mode
  );
  const fallbackDetected = engine.engine_id !== requestedEngineId;
  const requiresPersonalVoice =
    personalVoiceMode === 'require_personal_voice' ||
    (policy.routing.enforce_clone_engine_for_personal_tier && profile.tier === 'personal');
  if (requiresPersonalVoice && (engine.kind !== 'voice_clone_service' || fallbackDetected)) {
    return {
      status: 'blocked',
      request_id: jobId,
      profile_id: profile.profile_id,
      profile_tier: profile.tier,
      engine_id: requestedEngineId,
      resolved_engine_id: engine.engine_id,
      backend_id: backend.backend_id,
      backend_kind: backend.kind,
      backend_provider: backend.provider,
      fallback_detected: fallbackDetected,
      personal_voice_mode: personalVoiceMode,
      reason: fallbackDetected
        ? `personal voice required but engine resolved to fallback (${engine.engine_id})`
        : `personal voice required but resolved engine is not clone-capable (${engine.engine_id})`,
    };
  }
  const runtime = new VoiceGenerationRuntime(policy);
  const progress_packets: any[] = [];
  const speaker_verification: any[] = [];
  runtime.subscribe((packet) => {
    progress_packets.push(packet);
  });

  runtime.enqueue({
    jobId,
    async run(api) {
      api.report({
        status: 'loading_profile',
        progress: { current: 1, total: 4, percent: 25, unit: 'steps' },
        message: `resolved profile ${profile.profile_id}`,
      });
      api.report({
        status: 'loading_model',
        progress: { current: 2, total: 4, percent: 50, unit: 'steps' },
        message: `using engine ${engine.engine_id} (requested: ${requestedEngineId || defaultEngine.engine_id})`,
      });

      let artifactRefs: string[] = [];
      if (deliveryMode === 'artifact' || deliveryMode === 'artifact_and_playback') {
        const artifactRef = await renderNativeArtifact(String(input.text || ''), {
          requestId: jobId,
          voice: defaults.voice,
          rate: defaults.rate,
          language,
          format: requestedFormat,
          engineId: engine.engine_id,
          supportsFormats: engine.supports.artifact_formats,
          outputPath: input.delivery?.artifact_path,
          profile,
          requireVoiceClone: requiresPersonalVoice,
        });
        artifactRefs = [artifactRef];
      }

      api.report({
        status: 'generating',
        progress: { current: 0, total: Math.max(1, chunks.length), percent: 50, unit: 'chunks' },
        message: `chunking into ${chunks.length} segment(s) with ${crossfadeMs}ms crossfade policy`,
      });

      if (deliveryMode === 'playback' || deliveryMode === 'artifact_and_playback') {
        if (deliveryMode === 'artifact_and_playback' && artifactRefs.length > 0) {
          const verification = await performPlayback(
            String(input.text || ''),
            {
              language,
              voice: defaults.voice,
              rate: defaults.rate,
              engineId: engine.engine_id,
              profile,
              requireVoiceClone: requiresPersonalVoice,
            },
            artifactRefs[0]
          );
          speaker_verification.push({
            playback_source_path: artifactRefs[0],
            verification,
          });
        } else {
          for (let index = 0; index < chunks.length; index += 1) {
            if (api.isCancelled()) return { artifactRefs };
            api.report({
              status: 'generating',
              progress: {
                current: index + 1,
                total: Math.max(1, chunks.length),
                percent: ((index + 1) / Math.max(1, chunks.length)) * 100,
                unit: 'chunks',
              },
              message: `rendering chunk ${index + 1}/${chunks.length}`,
              artifact_refs: artifactRefs,
            });
            const verification = await performPlayback(chunks[index], {
              language,
              voice: defaults.voice,
              rate: defaults.rate,
              engineId: engine.engine_id,
              profile,
              requireVoiceClone: requiresPersonalVoice,
            });
            speaker_verification.push({
              chunk_index: index,
              playback_source_path: verification?.playback_source_path,
              verification,
            });
          }
        }
      }

      api.report({
        status: 'persisting',
        progress: { current: 4, total: 4, percent: 100, unit: 'steps' },
        message: 'voice generation runtime completed',
        artifact_refs: artifactRefs,
      });
      return { artifactRefs, speaker_verification };
    },
  });

  const finalPacket = await waitForVoiceJob(runtime, jobId);
  if (requiresPersonalVoice && finalPacket.status !== 'completed') {
    throw new Error(
      `[VOICE] personal voice generation failed with required learned-voice engine ${engine.engine_id}: ${finalPacket.message || finalPacket.status}`
    );
  }
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    request_id: jobId,
    profile_id: profile.profile_id,
    language,
    engine_id: requestedEngineId,
    resolved_engine_id: engine.engine_id,
    backend_id: backend.backend_id,
    backend_kind: backend.kind,
    backend_provider: backend.provider,
    chunks: chunks.length,
    progress_packets,
    artifact_refs: finalPacket.artifact_refs || [],
    speaker_verification,
    delivery_mode: deliveryMode,
    format: requestedFormat,
  };
}

async function registerVoiceProfile(input: {
  action: 'register_voice_profile';
  request_id: string;
  profile: {
    profile_id: string;
    display_name: string;
    tier: 'personal' | 'confidential' | 'public';
    languages: string[];
    default_engine_id: string;
    notes?: string;
  };
  samples: Array<{ sample_id: string; path: string; language?: string }>;
  policy?: { strict_personal_voice?: boolean; allow_update?: boolean };
}): Promise<any> {
  if (!String(input.request_id || '').trim()) {
    throw new Error('register_voice_profile requires request_id');
  }
  const ingestionPolicy = getVoiceSampleIngestionPolicy();
  const validation = validateVoiceProfileRegistration(
    {
      ...input,
      policy: { ...input.policy, strict_personal_voice: input.policy?.strict_personal_voice },
    },
    ingestionPolicy
  );
  if (!validation.ok) {
    return {
      status: 'blocked',
      action: 'register_voice_profile',
      request_id: input.request_id,
      policy_version: ingestionPolicy.version,
      violations: validation.violations,
      summary: validation.summary,
    };
  }

  // Direct upsert: update existing profile's sample_refs in registry
  if (input.policy?.allow_update) {
    const { registry, registryPath } = getWritableVoiceProfileRegistryForTier(input.profile.tier);
    const sampleRefs = materializeVoiceProfileSampleRefs(input.profile, input.samples);
    const existing = registry.profiles.find((p) => p.profile_id === input.profile.profile_id);
    const updated = existing
      ? { ...existing, ...input.profile, sample_refs: sampleRefs, status: existing.status }
      : { ...input.profile, sample_refs: sampleRefs, status: 'active' as const };
    const nextProfiles = existing
      ? registry.profiles.map((p) => (p.profile_id === input.profile.profile_id ? updated : p))
      : [...registry.profiles, updated];
    const nextDefaultProfileId = nextProfiles.some(
      (profile) => profile.profile_id === registry.default_profile_id
    )
      ? registry.default_profile_id
      : updated.profile_id;
    writeVoiceProfileRegistry(
      { ...registry, default_profile_id: nextDefaultProfileId, profiles: nextProfiles },
      registryPath
    );
    logger.info(
      `[VOICE] ${existing ? 'updated' : 'created'} profile ${input.profile.profile_id} with ${sampleRefs.length} sample(s)`
    );
    return {
      status: 'succeeded',
      action: 'register_voice_profile',
      request_id: input.request_id,
      profile_id: input.profile.profile_id,
      sample_refs: sampleRefs,
      upserted: true,
      summary: validation.summary,
    };
  }

  const receiptDir = pathResolver.sharedTmp('voice-profile-registration');
  safeMkdir(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `${input.request_id}.json`);
  safeWriteFile(
    receiptPath,
    JSON.stringify(
      {
        kind: 'voice_profile_registration_receipt',
        created_at: new Date().toISOString(),
        status: 'validated_pending_promotion',
        request_id: input.request_id,
        profile: input.profile,
        samples: input.samples,
        summary: validation.summary,
        policy_version: ingestionPolicy.version,
      },
      null,
      2
    )
  );

  return {
    status: 'succeeded',
    action: 'register_voice_profile',
    request_id: input.request_id,
    registration_receipt_path: receiptPath,
    summary: validation.summary,
    next_step: 'governance review and profile promotion required',
  };
}

async function transcribeVoiceSample(input: {
  action: 'transcribe_voice_sample';
  audio_path: string;
  language?: string;
  model?: string;
  write_sidecar?: boolean;
  prefer_timestamps?: boolean;
  backend?: 'auto' | 'bridge' | 'mlx_whisper';
  allow_synthetic?: boolean;
}): Promise<any> {
  const audioPath = resolveVoicePath(String(input.audio_path || '').trim(), 'audio-input');
  const preferTimestamps = input.prefer_timestamps !== false;
  const backendPreference = input.backend || 'auto';
  const bridges = getSpeechToTextBridges();
  const candidates: any[] = [];
  const errors: Error[] = [];

  const transcribeWithBridge = async (bridge: any): Promise<any | null> => {
    if (bridge.name === 'stub' && !input.allow_synthetic) return null;
    try {
      const result = normalizeSpeechToTextResult(
        bridge,
        await bridge.transcribe({
          audioPath,
          ...(input.language ? { language: input.language } : {}),
        })
      );
      const candidate = {
        status: 'succeeded',
        action: 'transcribe_voice_sample',
        audio_path: audioPath,
        transcript: result.text,
        language: result.language || input.language,
        backend: result.backend || bridge.name,
        capabilities: result.capabilities || getSpeechToTextCapabilities(bridge),
        priority: Number(bridge.priority || 0),
        ...(result.segments ? { segments: result.segments } : {}),
        ...(result.synthetic ? { synthetic: true } : {}),
      };
      candidates.push(candidate);
      return candidate;
    } catch (error: any) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      errors.push(normalized);
      logger.warn(`[VOICE] STT bridge ${bridge.name} unavailable: ${normalized.message}`);
      return null;
    }
  };

  let mlxError: Error | null = null;

  const transcribeWithMlxWhisper = (): any | null => {
    const bridgeScript = pathResolver.rootResolve(
      'libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py'
    );
    const payload = JSON.stringify({
      action: 'transcribe',
      params: {
        audio_path: audioPath,
        ...(input.language ? { language: input.language } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
    });
    const commandResult = safeExecResult(resolvePythonBin('mlx_whisper'), [bridgeScript], {
      input: payload,
      env: { KYBERION_PROJECT_ROOT: pathResolver.rootResolve('.') },
    });
    if (commandResult.error || commandResult.status !== 0) {
      mlxError = new Error(
        `mlx_audio_stt_bridge failed: ${commandResult.stderr || commandResult.error?.message}`
      );
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(commandResult.stdout);
    } catch {
      mlxError = new Error(`mlx_audio_stt_bridge returned non-JSON: ${commandResult.stdout}`);
      return null;
    }
    if (parsed.status !== 'success') {
      mlxError = new Error(`mlx_audio_stt_bridge error: ${parsed.error}`);
      return null;
    }
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const result = normalizeSpeechToTextResult(
      { name: 'mlx-whisper', capabilities: parsed.capabilities },
      {
        text: parsed.text,
        language: parsed.language,
        backend: 'mlx-whisper',
        capabilities: parsed.capabilities || {
          timestamps: segments.length > 0,
          granularity: segments.length > 0 ? 'segment' : 'none',
        },
        segments,
      }
    );
    const candidate = {
      status: 'succeeded',
      action: 'transcribe_voice_sample',
      audio_path: audioPath,
      model: parsed.model,
      ...result,
      priority: 100,
    };
    candidates.push(candidate);
    return candidate;
  };

  const usableBridges = bridges.filter((bridge) => bridge.name !== 'stub' || input.allow_synthetic);
  const timestampBridges = usableBridges.filter(
    (bridge) => getSpeechToTextCapabilities(bridge).timestamps
  );
  const textBridges = usableBridges.filter(
    (bridge) => !getSpeechToTextCapabilities(bridge).timestamps
  );

  if (backendPreference === 'mlx_whisper') {
    transcribeWithMlxWhisper();
  } else if (backendPreference === 'bridge') {
    for (const bridge of [...timestampBridges, ...textBridges]) {
      await transcribeWithBridge(bridge);
    }
  } else if (preferTimestamps) {
    for (const bridge of timestampBridges) {
      const result = await transcribeWithBridge(bridge);
      if (result?.capabilities?.timestamps) break;
    }
    if (!candidates.some((candidate) => candidate.capabilities?.timestamps)) {
      transcribeWithMlxWhisper();
    }
    if (!candidates.some((candidate) => candidate.capabilities?.timestamps)) {
      for (const bridge of textBridges) {
        if (await transcribeWithBridge(bridge)) break;
      }
    }
  } else {
    for (const bridge of textBridges) {
      if (await transcribeWithBridge(bridge)) break;
    }
    if (candidates.length === 0) transcribeWithMlxWhisper();
  }

  const selected = candidates.sort((left, right) => {
    const leftTimestamped = left.capabilities?.timestamps ? 1 : 0;
    const rightTimestamped = right.capabilities?.timestamps ? 1 : 0;
    return (
      rightTimestamped - leftTimestamped || Number(right.priority || 0) - Number(left.priority || 0)
    );
  })[0];
  if (!selected) {
    throw new Error(
      `[VOICE] no usable STT backend: ${errors[0]?.message || mlxError?.message || 'unknown error'}`
    );
  }

  logger.info(
    `[VOICE] STT確認完了: backend=${selected.backend}, ` +
      `timestamps=${Boolean(selected.capabilities?.timestamps)}, ` +
      `granularity=${selected.capabilities?.granularity || 'none'}`
  );

  if (input.write_sidecar !== false) {
    const digest = createHash('sha256').update(audioPath).digest('hex').slice(0, 20);
    const adjacentSidecar = `${audioPath}.transcript.txt`;
    const sidecarPath = (() => {
      try {
        return resolveVoicePath(adjacentSidecar, 'transcript-output');
      } catch {
        return pathResolver.sharedTmp(`stt-sidecars/${digest}.transcript.txt`);
      }
    })();
    const sidecarDir = path.dirname(sidecarPath);
    safeMkdir(sidecarDir, { recursive: true });
    safeWriteFile(sidecarPath, selected.transcript);
    logger.info(`[VOICE] transcript written to ${sidecarPath}`);
  }

  return {
    ...selected,
    selected_backend: selected.backend,
    selected_capabilities: selected.capabilities,
  };
}

function deepResolve(val: any, ctx: any): any {
  if (typeof val === 'string') return resolveVars(val, ctx);
  if (Array.isArray(val)) return val.map((item) => deepResolve(item, ctx));
  if (val !== null && typeof val === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) result[k] = deepResolve(v, ctx);
    return result;
  }
  return val;
}

export async function dispatchDecisionOp(
  op: string,
  params: Record<string, any>,
  ctx: Record<string, any>
): Promise<{ handled: boolean; ctx: any }> {
  const resolvedParams = deepResolve(params, ctx);
  const payload = { action: op, ...resolvedParams };
  try {
    const result = await handleSingleAction(payload as any);
    const exportAs = resolvedParams.export_as;
    return {
      handled: true,
      ctx: exportAs ? { ...ctx, [exportAs]: result } : { ...ctx, last_voice_result: result },
    };
  } catch (err: any) {
    throw err;
  }
}

const main = async () => {
  await runActuatorCli({
    name: 'voice-actuator',
    handleAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
