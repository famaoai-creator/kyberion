import { createCoreAudioDeviceInventoryBridge } from '@agent/core/coreaudio-device-inventory';
import { checkMeetingParticipationConsent } from '@agent/core/meeting-participation-coordinator';
import { getStreamingSttBridge } from '@agent/core/streaming-stt-bridge';
import { getVoiceProfileRegistry } from '@agent/core/voice-profile-registry';
import { getVoiceTtsLanguageConfig } from '@agent/core/voice-tts-config';
import { installShellStreamingSttBridgeFromEnv } from '@agent/core/shell-streaming-stt-bridge';
import { pathResolver } from '@agent/core/path-resolver';
import { TtsLoopbackVerifier } from '@agent/core/tts-loopback-verifier';
import { resolveVoiceBackend } from '@agent/core/media-backend-registry';
import { resolveVoiceEngineForPlatform } from '@agent/core/voice-engine-registry';
import { safeExec } from '@agent/core/secure-io';
import { StubAudioBus } from '@agent/core/audio-bus';
import { BlackHoleAudioBus } from '@agent/core/blackhole-audio-bus';
import { performPlayback } from './voice-runtime-helpers.js';
import { getRegisteredEnvText } from '@agent/core/foundation';
import {
  booleanParam,
  buildLoopbackRequest,
  createDeterministicLoopbackStt,
  createDeterministicLoopbackTts,
  createNativeArtifactTtsSource,
  recordParam,
  stringParam,
} from './voice-loopback-helpers.js';
import { registerVoiceLoopbackSttAdapter } from './voice-stt-backend-adapters.js';

import { compileSchema } from '@agent/core/foundation';

const voiceActionValidate = compileSchema(
  pathResolver.rootResolve('knowledge/product/schemas/voice-action.schema.json')
);

export function validateVoiceAction(input: unknown): void {
  const ok = voiceActionValidate(input);
  if (ok) return;
  const detail = (voiceActionValidate.errors || [])
    .map((error: any) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`Invalid voice action: ${detail}`);
}

export async function listVoices(): Promise<any> {
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

export async function listAudioRoutes(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
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

export async function probeAudioRoute(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
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

export function buildAudioRouteViewModel(
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

export async function verifyTtsLoopback(
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
  const configuredSttBridge = stringParam(params, 'stt_bridge_id');
  const sttBridgeId =
    configuredSttBridge ||
    (process.platform === 'win32' &&
    getRegisteredEnvText('KYBERION_WINDOWS_STT_BACKEND') === 'faster_whisper'
      ? 'faster_whisper'
      : undefined);
  registerVoiceLoopbackSttAdapter(sttBridgeId, { request_id: requestId, language });
  if (
    sttBridgeId === 'shell' ||
    getRegisteredEnvText('KYBERION_STREAMING_STT_BRIDGE') === 'shell'
  ) {
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

export async function speakLocal(params: Record<string, unknown>): Promise<any> {
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
