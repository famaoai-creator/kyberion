/**
 * Meeting Participation CLI.
 *
 * The "real" version of `meeting:run`: actually joins the meeting,
 * captures audio, transcribes it, hands the transcript to the
 * reasoning backend, and speaks the reply back via TTS.
 *
 * Wiring uses the small abstractions in `@agent/core`:
 *
 *   resolveAudioBus()                    → BlackHole / PulseAudio / stub
 *   getMeetingJoinDriver(driver_id)      → browser-playwright by default
 *   getStreamingSttBridge()              → stub or KYBERION_STT_COMMAND
 *   getStreamingTtsBridge()              → stub or KYBERION_TTS_COMMAND
 *   EnergyVad                             → built-in VAD
 *   MeetingParticipationCoordinator      → owns the loop
 *
 * Usage:
 *   pnpm meeting:participate \
 *     --mission MSN-MTG-LIVE-001 \
 *     --meeting-url https://meet.google.com/abc-defg-hij \
 *     --platform meet \
 *     --display-name "Kyberion (operator delegate)" \
 *     --max-minutes 30
 */

import {
  EnergyVad,
  MeetingParticipationCoordinator,
  StubMeetingJoinDriver,
  getMeetingJoinDriver,
  installInRoomMeetingJoinDriver,
  installChromeExtensionMeetingJoinDriver,
  getStreamingSttBridge,
  getStreamingTtsBridge,
  getVoiceProfileRegistry,
  installShellStreamingSttBridgeFromEnv,
  installShellStreamingTtsBridgeFromEnv,
  loadEnvironmentManifest,
  logger,
  registerMeetingJoinDriver,
  resolveAudioBus,
  verifyReady,
  TraceContext,
  finalizeAndPersist,
  pathResolver,
  type AudioFormat,
  type ConversationAgent,
  type MeetingJoinDriver,
  type MeetingTarget,
  type TranscriptChunk,
  getReasoningBackend,
  resolveMeetingParticipationRuntimePlan,
  validateMeetingTarget,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { pathToFileURL } from 'node:url';
// Side-effect imports register the audio-bus capability probes so the
// participation-runtime manifest can resolve `audio-bus.blackhole` etc.
import '@agent/core/blackhole-audio-bus';
import '@agent/core/pulse-audio-bus';

const FORMAT: AudioFormat = {
  encoding: 'pcm_s16le',
  sample_rate_hz: 16000,
  channels: 1,
};

class ReasoningBackendAgent implements ConversationAgent {
  private readonly backend = getReasoningBackend();
  private utterances: TranscriptChunk[] = [];
  constructor(
    private readonly missionId: string,
    private readonly persona: string
  ) {}

  async onUtterance(utt: TranscriptChunk): Promise<{ speech?: string; leave?: boolean }> {
    this.utterances.push(utt);
    if (utt.text.trim().length === 0) return {};
    const transcript = this.utterances
      .map((u) => `- ${u.speaker_label ?? 'speaker'}: ${u.text}`)
      .join('\n');
    const prompt = [
      `You are participating in a live meeting as ${this.persona}.`,
      'Output ONLY a JSON object: { "speech": str (≤2 sentences), "leave": bool }.',
      'No prose, no code fence. Reply only when you have something useful to add. Use empty speech to stay silent.',
      'Recent transcript:',
      transcript,
    ].join('\n');
    try {
      const raw = await this.backend.delegateTask(prompt, `meeting:${this.missionId}`);
      const json = extractFirstJson(raw);
      const speech = typeof json?.speech === 'string' ? json.speech : '';
      const leave = Boolean(json?.leave);
      return speech || leave ? { ...(speech ? { speech } : {}), leave } : {};
    } catch (err: any) {
      logger.warn(`[participate-cli] backend.delegateTask failed: ${err?.message ?? err}`);
      return {};
    }
  }
}

function extractFirstJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function prepareMeetingTarget(
  target: MeetingTarget
): MeetingTarget & { platform: 'meet' | 'zoom' | 'teams' | 'in_room' } {
  return validateMeetingTarget(target);
}

async function loadDriver(
  driverId: string,
  opts: {
    headed?: boolean;
    accountSlug?: string;
    microphoneDevice?: string;
    speakerDevice?: string;
    cameraDevice?: string;
    userDataDir?: string;
    profileDirectory?: string;
    connectOverCdp?: boolean;
    cdpUrl?: string;
    cdpPort?: number;
    browserChannel?: 'chrome' | 'chromium';
    extensionWsPort?: number;
    extensionWsHost?: string;
    extensionJoinTimeoutSec?: number;
  } = {}
): Promise<MeetingJoinDriver> {
  if (driverId === 'in-room') {
    // 同席モード: attend the physical meeting through the machine's own
    // microphone/speakers — no browser, no external bot service.
    installInRoomMeetingJoinDriver({
      mic: opts.microphoneDevice ? { device: opts.microphoneDevice } : undefined,
    });
  }
  if (driverId === 'browser-playwright') {
    try {
      const mod = await import('@actuator/meeting-browser-driver');
      mod.installBrowserMeetingJoinDriver({
        headed: Boolean(opts.headed),
        user_data_dir: opts.userDataDir,
        profile_directory: opts.profileDirectory,
        connect_over_cdp: Boolean(opts.connectOverCdp),
        cdp_url: opts.cdpUrl,
        cdp_port: opts.cdpPort,
        browser_channel: opts.browserChannel,
        account_slug: opts.accountSlug,
        microphone_device: opts.microphoneDevice,
        speaker_device: opts.speakerDevice,
        camera_device: opts.cameraDevice,
      });
    } catch (err: any) {
      try {
        const fallbackPath = pathResolver.rootResolve(
          'dist/libs/actuators/meeting-browser-driver/src/index.js'
        );
        const mod = await import(pathToFileURL(fallbackPath).href);
        if (typeof mod.installBrowserMeetingJoinDriver === 'function') {
          mod.installBrowserMeetingJoinDriver({
            headed: Boolean(opts.headed),
            user_data_dir: opts.userDataDir,
            profile_directory: opts.profileDirectory,
            connect_over_cdp: Boolean(opts.connectOverCdp),
            cdp_url: opts.cdpUrl,
            cdp_port: opts.cdpPort,
            browser_channel: opts.browserChannel,
            account_slug: opts.accountSlug,
            microphone_device: opts.microphoneDevice,
            speaker_device: opts.speakerDevice,
            camera_device: opts.cameraDevice,
          });
          logger.info(`[participate-cli] browser driver loaded from ${fallbackPath}`);
        } else {
          throw new Error('fallback driver module did not export installBrowserMeetingJoinDriver');
        }
      } catch (fallbackErr: any) {
        logger.warn(
          `[participate-cli] browser driver not installed; falling back to stub. (${fallbackErr?.message ?? err?.message ?? err})`
        );
      }
    }
  }
  if (driverId === 'chrome-extension') {
    // Browser control via the operator's own Chrome running the Meet Copilot
    // extension (tools/meet-copilot-extension), over a local WebSocket channel.
    // Audio still flows through the BlackHole bus (decoupled from the driver).
    installChromeExtensionMeetingJoinDriver({
      wsPort: opts.extensionWsPort,
      wsHost: opts.extensionWsHost,
      joinTimeoutSec: opts.extensionJoinTimeoutSec,
    });
  }
  const driver = getMeetingJoinDriver(driverId);
  if (driver) {
    const probe = await driver.probe();
    if (probe.available) return driver;
    logger.warn(
      `[participate-cli] driver '${driverId}' unavailable: ${probe.reason}; falling back to stub`
    );
  }
  registerMeetingJoinDriver(new StubMeetingJoinDriver());
  return new StubMeetingJoinDriver();
}

export interface MeetingBootstrapGateResult {
  ready: boolean;
  skipped: boolean;
}

export async function evaluateMeetingBootstrapGate(
  missionId: string,
  trace: TraceContext,
  opts: {
    skipBootstrapCheck: boolean;
    loadManifest?: typeof loadEnvironmentManifest;
    readinessCheck?: typeof verifyReady;
  }
): Promise<MeetingBootstrapGateResult> {
  const loadManifest = opts.loadManifest ?? loadEnvironmentManifest;
  const readinessCheck = opts.readinessCheck ?? verifyReady;

  trace.startSpan('meeting_participate.bootstrap_gate', {
    skipped: opts.skipBootstrapCheck,
  });

  try {
    if (opts.skipBootstrapCheck) {
      trace.addEvent('meeting_participate.bootstrap_gate_skipped', {
        mission_id: missionId,
      });
      trace.endSpan('ok');
      return { ready: true, skipped: true };
    }

    const manifest = loadManifest('meeting-participation-runtime');
    const ready = readinessCheck(manifest, { mission_id: missionId });
    if (!ready.ready) {
      trace.addEvent('meeting_participate.bootstrap_gate_failed', {
        manifest_id: manifest.manifest_id,
        missing: ready.missing.length,
      });
      for (const missing of ready.missing) {
        trace.addEvent('meeting_participate.bootstrap_gate_missing', {
          capability_id: missing.capability_id,
        });
      }
      trace.endSpan('error', 'environment-capability gate is not satisfied');
      return { ready: false, skipped: false };
    }

    trace.addEvent('meeting_participate.bootstrap_gate_ready', {
      manifest_id: manifest.manifest_id,
      missing: 0,
    });
    trace.endSpan('ok');
    return { ready: true, skipped: false };
  } catch (err: any) {
    trace.addEvent('meeting_participate.bootstrap_gate_error', {
      error: err?.message ?? String(err),
    });
    trace.endSpan('error', err?.message ?? String(err));
    return { ready: false, skipped: false };
  }
}

export function assertMeetingParticipationRuntime(input: {
  runtimePlan: ReturnType<typeof resolveMeetingParticipationRuntimePlan>;
  bus: { bus_id: string };
  busProbe: { available: boolean; reason?: string };
  stt: { bridge_id: string };
  tts: { bridge_id: string };
}): void {
  const { runtimePlan, bus, busProbe, stt, tts } = input;
  if (runtimePlan.require_real_audio_bus && (bus.bus_id === 'stub' || !busProbe.available)) {
    throw new Error(
      `[participate-cli] transport mode '${runtimePlan.transport_mode}' requires a real audio bus, but bus='${bus.bus_id}' probe='${busProbe.reason ?? 'unavailable'}'`
    );
  }
  if (runtimePlan.require_streaming_stt && stt.bridge_id === 'stub') {
    throw new Error(
      `[participate-cli] transport mode '${runtimePlan.transport_mode}' requires streaming STT, but only the stub bridge is registered. Set KYBERION_STT_COMMAND or register a real bridge.`
    );
  }
  if (runtimePlan.require_streaming_tts && tts.bridge_id === 'stub') {
    throw new Error(
      `[participate-cli] transport mode '${runtimePlan.transport_mode}' requires streaming TTS, but only the stub bridge is registered. Set KYBERION_TTS_COMMAND or register a real bridge.`
    );
  }
}

export function resolveMeetingParticipationVoiceProfile(
  input: {
    voiceProfileId?: string;
    registry?: ReturnType<typeof getVoiceProfileRegistry>;
  } = {}
) {
  const registry = input.registry ?? getVoiceProfileRegistry();
  const requestedProfileId = input.voiceProfileId?.trim();

  if (requestedProfileId) {
    const explicit = registry.profiles.find((profile) => profile.profile_id === requestedProfileId);
    if (!explicit) {
      throw new Error(
        `[participate-cli] requested voice profile '${requestedProfileId}' is not present in the active registry.`
      );
    }
    return explicit;
  }

  const defaultProfile =
    registry.profiles.find((profile) => profile.profile_id === registry.default_profile_id) ||
    registry.profiles.find((profile) => profile.status === 'active');
  if (!defaultProfile) {
    throw new Error('[participate-cli] no active voice profile is available in the registry');
  }
  return defaultProfile;
}

export function shouldResolveMeetingParticipationVoiceProfile(input: {
  runtimePlan: ReturnType<typeof resolveMeetingParticipationRuntimePlan>;
  voiceProfileId?: string;
}): boolean {
  return input.runtimePlan.require_voice_profile || Boolean(input.voiceProfileId?.trim());
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('mission', { type: 'string', demandOption: true })
    .option('meeting-url', { type: 'string' })
    .option('platform', { type: 'string', default: 'auto' })
    .option('meeting-id', { type: 'string' })
    .option('passcode', { type: 'string' })
    .option('display-name', { type: 'string', default: 'Kyberion' })
    .option('persona', { type: 'string', default: 'an attentive meeting participant' })
    .option('voice-profile-id', { type: 'string' })
    .option('driver', { type: 'string', default: 'browser-playwright' })
    .option('audio-bus', { type: 'string' })
    .option('transport-mode', {
      type: 'string',
      choices: ['transcribe_first', 'captions_first', 'realtime_voice'] as const,
      default: 'transcribe_first',
    })
    .option('dry-run', { type: 'boolean', default: false })
    .option('microphone-device', { type: 'string' })
    .option('speaker-device', { type: 'string' })
    .option('camera-device', { type: 'string' })
    .option('user-data-dir', { type: 'string' })
    .option('profile-directory', { type: 'string' })
    .option('connect-over-cdp', { type: 'boolean', default: false })
    .option('cdp-url', { type: 'string' })
    .option('cdp-port', { type: 'number' })
    .option('browser-channel', { type: 'string', choices: ['chrome', 'chromium'] as const })
    .option('extension-ws-port', {
      type: 'number',
      describe: 'chrome-extension driver: local WS control port (default 8779)',
    })
    .option('extension-ws-host', {
      type: 'string',
      describe: 'chrome-extension driver: local WS host (default 127.0.0.1)',
    })
    .option('extension-join-timeout-sec', {
      type: 'number',
      describe: 'chrome-extension driver: seconds to wait for the extension to connect + join',
    })
    .option('max-minutes', { type: 'number', default: 30 })
    .option('self-audio-suppression-ms', { type: 'number', default: 0 })
    .option('post-playback-drain-ms', { type: 'number', default: 400 })
    .option('barge-in-enabled', { type: 'boolean', default: false })
    .option('barge-in-rms-multiplier', { type: 'number', default: 2.5 })
    .option('barge-in-min-duration-ms', { type: 'number', default: 160 })
    .option('headed', { type: 'boolean', default: false })
    .option('account-slug', { type: 'string', default: 'default' })
    .option('skip-bootstrap-check', { type: 'boolean', default: false })
    .parseSync();

  const missionId = String(argv.mission);
  process.env.MISSION_ID = missionId;
  const trace = new TraceContext(`meeting_participate:${missionId}`, {
    missionId,
    actuator: 'meeting-participate',
  });
  let exitCode = 0;

  try {
    // Fail-closed on missing environment-capability receipt unless the
    // operator explicitly opts out. Run `pnpm env:bootstrap --manifest
    // meeting-participation-runtime --apply [--force]` to satisfy it.
    const gate = await evaluateMeetingBootstrapGate(missionId, trace, {
      skipBootstrapCheck: Boolean(argv['skip-bootstrap-check']),
    });
    if (!gate.ready) {
      logger.error(
        `[participate-cli] environment-capability gate is not satisfied for mission ${missionId}.`
      );
      logger.error(
        'Run `pnpm env:bootstrap --manifest meeting-participation-runtime --apply [--force]` to install,'
      );
      logger.error(
        'or pass --skip-bootstrap-check (only for incident response — every skip is audited downstream).'
      );
      exitCode = 2;
      return;
    }

    // Try to register optional shell bridges from env. If they fail, the
    // registry stays at stub.
    installShellStreamingSttBridgeFromEnv();
    installShellStreamingTtsBridgeFromEnv();

    const runtimePlan = resolveMeetingParticipationRuntimePlan({
      transport_mode: argv['transport-mode'] as
        | 'transcribe_first'
        | 'captions_first'
        | 'realtime_voice'
        | undefined,
      dry_run: Boolean(argv['dry-run']),
    });
    logger.info(
      `[participate-cli] runtime plan transport=${runtimePlan.transport_mode} dry_run=${runtimePlan.dry_run} real_audio_bus=${runtimePlan.require_real_audio_bus} stt=${runtimePlan.require_streaming_stt} tts=${runtimePlan.require_streaming_tts} voice_profile=${runtimePlan.require_voice_profile}`
    );
    if (
      runtimePlan.transport_mode === 'captions_first' &&
      String(argv.driver) !== 'chrome-extension'
    ) {
      logger.error(
        '[participate-cli] --transport-mode captions_first requires --driver chrome-extension (platform live captions are scraped by the Meet Copilot extension).'
      );
      exitCode = 2;
      return;
    }

    // 同席モード (--driver in-room): the meeting is in the physical room, so
    // no meeting URL is required and the platform is forced to in_room.
    const inRoom = String(argv.driver) === 'in-room' || argv.platform === 'in_room';
    const meetingUrl =
      typeof argv['meeting-url'] === 'string' && argv['meeting-url']
        ? String(argv['meeting-url'])
        : inRoom
          ? 'room://local'
          : '';
    if (!meetingUrl) {
      logger.error('[participate-cli] --meeting-url is required (except with --driver in-room).');
      exitCode = 2;
      return;
    }
    const target: MeetingTarget = {
      url: meetingUrl,
      platform: inRoom ? 'in_room' : ((argv.platform as MeetingTarget['platform']) ?? 'auto'),
      meeting_id: typeof argv['meeting-id'] === 'string' ? String(argv['meeting-id']) : undefined,
      passcode: typeof argv.passcode === 'string' ? String(argv.passcode) : undefined,
      display_name: String(argv['display-name']),
    };
    const validatedTarget = prepareMeetingTarget(target);
    const requestedVoiceProfileId =
      typeof argv['voice-profile-id'] === 'string' ? String(argv['voice-profile-id']) : undefined;
    const voiceProfile = shouldResolveMeetingParticipationVoiceProfile({
      runtimePlan,
      voiceProfileId: requestedVoiceProfileId,
    })
      ? resolveMeetingParticipationVoiceProfile({ voiceProfileId: requestedVoiceProfileId })
      : null;
    if (runtimePlan.require_voice_profile && voiceProfile?.status !== 'active') {
      throw new Error(
        `[participate-cli] transport mode '${runtimePlan.transport_mode}' requires an active voice profile, but '${voiceProfile?.profile_id ?? 'none'}' is ${voiceProfile?.status ?? 'missing'}`
      );
    }

    const driver = await loadDriver(String(argv.driver), {
      headed: Boolean(argv.headed),
      accountSlug: String(argv['account-slug']),
      microphoneDevice:
        typeof argv['microphone-device'] === 'string'
          ? String(argv['microphone-device'])
          : undefined,
      speakerDevice:
        typeof argv['speaker-device'] === 'string' ? String(argv['speaker-device']) : undefined,
      cameraDevice:
        typeof argv['camera-device'] === 'string' ? String(argv['camera-device']) : undefined,
      userDataDir:
        typeof argv['user-data-dir'] === 'string' ? String(argv['user-data-dir']) : undefined,
      profileDirectory:
        typeof argv['profile-directory'] === 'string'
          ? String(argv['profile-directory'])
          : undefined,
      connectOverCdp: Boolean(argv['connect-over-cdp']),
      cdpUrl: typeof argv['cdp-url'] === 'string' ? String(argv['cdp-url']) : undefined,
      cdpPort: typeof argv['cdp-port'] === 'number' ? Number(argv['cdp-port']) : undefined,
      browserChannel: (argv['browser-channel'] as 'chrome' | 'chromium' | undefined) ?? undefined,
      extensionWsPort:
        typeof argv['extension-ws-port'] === 'number'
          ? Number(argv['extension-ws-port'])
          : undefined,
      extensionWsHost:
        typeof argv['extension-ws-host'] === 'string'
          ? String(argv['extension-ws-host'])
          : undefined,
      extensionJoinTimeoutSec:
        typeof argv['extension-join-timeout-sec'] === 'number'
          ? Number(argv['extension-join-timeout-sec'])
          : undefined,
    });
    const selectedDevices = {
      microphone:
        typeof argv['microphone-device'] === 'string'
          ? String(argv['microphone-device'])
          : undefined,
      speaker:
        typeof argv['speaker-device'] === 'string' ? String(argv['speaker-device']) : undefined,
      camera: typeof argv['camera-device'] === 'string' ? String(argv['camera-device']) : undefined,
    };
    if (selectedDevices.microphone || selectedDevices.speaker || selectedDevices.camera) {
      logger.info(
        `[participate-cli] device preferences microphone=${selectedDevices.microphone ?? 'default'} speaker=${selectedDevices.speaker ?? 'default'} camera=${selectedDevices.camera ?? 'default'}`
      );
    }
    if (argv['connect-over-cdp'] || argv['user-data-dir']) {
      logger.info(
        `[participate-cli] browser mode ${argv['connect-over-cdp'] ? 'cdp-attach' : 'persistent-profile'}${argv['profile-directory'] ? ` profile=${argv['profile-directory']}` : ''}${argv['cdp-url'] ? ` cdp_url=${argv['cdp-url']}` : ''}${argv['cdp-port'] ? ` cdp_port=${argv['cdp-port']}` : ''}`
      );
    }
    const bus = resolveAudioBus((argv['audio-bus'] as any) || undefined);
    const busProbe = await bus.probe();
    if (!busProbe.available) {
      logger.warn(`[participate-cli] audio bus '${bus.bus_id}' unavailable: ${busProbe.reason}`);
      trace.addEvent('meeting_participate.audio_bus_unavailable', {
        bus_id: bus.bus_id,
      });
    }
    const stt = getStreamingSttBridge();
    const tts = getStreamingTtsBridge();
    assertMeetingParticipationRuntime({ runtimePlan, bus, busProbe, stt, tts });

    const coordinator = new MeetingParticipationCoordinator({
      driver,
      bus,
      stt,
      tts,
      vad: new EnergyVad(),
      agent: new ReasoningBackendAgent(missionId, String(argv.persona)),
      trace,
    });

    logger.info(
      `🎙️ meeting_participate (mission=${missionId} driver=${driver.driver_id} bus=${bus.bus_id} platform=${validatedTarget.platform} voice_profile=${voiceProfile?.profile_id ?? 'not_required'})`
    );

    const report = await coordinator.run(validatedTarget, {
      mission_id: missionId,
      max_minutes: Number(argv['max-minutes']),
      voice_profile_id: voiceProfile?.profile_id ?? '',
      audio_format: FORMAT,
      require_recording_consent: runtimePlan.require_recording_consent,
      require_voice_consent: runtimePlan.require_voice_consent,
      self_audio_suppression_ms: Math.max(0, Number(argv['self-audio-suppression-ms'])),
      post_playback_drain_ms: Math.max(0, Number(argv['post-playback-drain-ms'])),
      barge_in_enabled: Boolean(argv['barge-in-enabled']),
      barge_in_rms_multiplier: Math.max(1, Number(argv['barge-in-rms-multiplier'])),
      barge_in_min_duration_ms: Math.max(20, Number(argv['barge-in-min-duration-ms'])),
      transcript_source:
        runtimePlan.transport_mode === 'captions_first' ? 'driver_captions' : 'stt',
    });
    logger.info('');
    logger.info(`📋 Participation report:`);
    logger.info(`   session_id: ${report.session_id}`);
    logger.info(`   joined_at:  ${report.joined_at}`);
    logger.info(`   left_at:    ${report.left_at}`);
    logger.info(`   utterances heard:  ${report.utterances_received}`);
    logger.info(`   utterances spoken: ${report.utterances_spoken}`);
    logger.info(`   ended_by_timeout:  ${report.ended_by_timeout}`);
  } catch (err: any) {
    trace.addEvent('meeting_participate.cli_error', {
      error: err?.message ?? String(err),
    });
    logger.error(err?.message ?? String(err));
    exitCode = 1;
  } finally {
    const persisted = finalizeAndPersist(trace);
    logger.info(`📋 meeting_participate trace: ${persisted.path}`);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  }
}

const isDirect = process.argv[1] && /meeting_participate\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exitCode = 1;
  });
}

export { main as runMeetingParticipate };
