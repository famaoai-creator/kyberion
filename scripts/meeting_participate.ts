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
  getStreamingSttBridge,
  getStreamingTtsBridge,
  installShellStreamingSttBridgeFromEnv,
  installShellStreamingTtsBridgeFromEnv,
  loadEnvironmentManifest,
  logger,
  registerMeetingJoinDriver,
  resolveAudioBus,
  verifyReady,
  type AudioFormat,
  type ConversationAgent,
  type MeetingJoinDriver,
  type MeetingTarget,
  type TranscriptChunk,
  getReasoningBackend,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
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
  constructor(private readonly missionId: string, private readonly persona: string) {}

  async onUtterance(utt: TranscriptChunk): Promise<{ speech?: string; leave?: boolean }> {
    this.utterances.push(utt);
    if (utt.text.trim().length === 0) return {};
    const transcript = this.utterances.map((u) => `- ${u.speaker_label ?? 'speaker'}: ${u.text}`).join('\n');
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

async function loadDriver(driverId: string): Promise<MeetingJoinDriver> {
  if (driverId === 'browser-playwright') {
    try {
      const mod = await import('@actuator/meeting-browser-driver');
      mod.installBrowserMeetingJoinDriver();
    } catch (err: any) {
      logger.warn(
        `[participate-cli] browser driver not installed; falling back to stub. (${err?.message ?? err})`,
      );
    }
  }
  const driver = getMeetingJoinDriver(driverId);
  if (driver) {
    const probe = await driver.probe();
    if (probe.available) return driver;
    logger.warn(`[participate-cli] driver '${driverId}' unavailable: ${probe.reason}; falling back to stub`);
  }
  registerMeetingJoinDriver(new StubMeetingJoinDriver());
  return new StubMeetingJoinDriver();
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('mission', { type: 'string', demandOption: true })
    .option('meeting-url', { type: 'string', demandOption: true })
    .option('platform', { type: 'string', default: 'auto' })
    .option('display-name', { type: 'string', default: 'Kyberion' })
    .option('persona', { type: 'string', default: 'an attentive meeting participant' })
    .option('voice-profile-id', { type: 'string', default: 'operator-default-v1' })
    .option('driver', { type: 'string', default: 'browser-playwright' })
    .option('audio-bus', { type: 'string' })
    .option('max-minutes', { type: 'number', default: 30 })
    .option('headed', { type: 'boolean', default: false })
    .option('skip-bootstrap-check', { type: 'boolean', default: false })
    .parseSync();

  const missionId = String(argv.mission);
  process.env.MISSION_ID = missionId;

  // Fail-closed on missing environment-capability receipt unless the
  // operator explicitly opts out. Run `pnpm env:bootstrap --manifest
  // meeting-participation-runtime --apply [--force]` to satisfy it.
  if (!argv['skip-bootstrap-check']) {
    try {
      const manifest = loadEnvironmentManifest('meeting-participation-runtime');
      const ready = verifyReady(manifest, { mission_id: missionId });
      if (!ready.ready) {
        logger.error(
          `[participate-cli] environment-capability gate is not satisfied for manifest '${manifest.manifest_id}'.`,
        );
        for (const m of ready.missing) {
          logger.error(`   - ${m.capability_id}: ${m.reason ?? 'unsatisfied'}`);
        }
        logger.error(
          'Run `pnpm env:bootstrap --manifest meeting-participation-runtime --apply [--force]` to install,',
        );
        logger.error(
          'or pass --skip-bootstrap-check (only for incident response — every skip is audited downstream).',
        );
        process.exit(2);
      }
    } catch (err: any) {
      logger.warn(
        `[participate-cli] could not load manifest 'meeting-participation-runtime'; proceeding without gate (${err?.message ?? err})`,
      );
    }
  }

  // Try to register optional shell bridges from env. If they fail, the
  // registry stays at stub.
  installShellStreamingSttBridgeFromEnv();
  installShellStreamingTtsBridgeFromEnv();

  const target: MeetingTarget = {
    url: String(argv['meeting-url']),
    platform: (argv.platform as MeetingTarget['platform']) ?? 'auto',
    display_name: String(argv['display-name']),
  };

  const driver = await loadDriver(String(argv.driver));
  const bus = resolveAudioBus((argv['audio-bus'] as any) || undefined);
  const busProbe = await bus.probe();
  if (!busProbe.available) {
    logger.warn(`[participate-cli] audio bus '${bus.bus_id}' unavailable: ${busProbe.reason}`);
  }

  const coordinator = new MeetingParticipationCoordinator({
    driver,
    bus,
    stt: getStreamingSttBridge(),
    tts: getStreamingTtsBridge(),
    vad: new EnergyVad(),
    agent: new ReasoningBackendAgent(missionId, String(argv.persona)),
  });

  logger.info(
    `🎙️ meeting_participate (mission=${missionId} driver=${driver.driver_id} bus=${bus.bus_id} platform=${target.platform})`,
  );

  const report = await coordinator.run(target, {
    max_minutes: Number(argv['max-minutes']),
    voice_profile_id: String(argv['voice-profile-id']),
    audio_format: FORMAT,
  });

  logger.info('');
  logger.info(`📋 Participation report:`);
  logger.info(`   session_id: ${report.session_id}`);
  logger.info(`   joined_at:  ${report.joined_at}`);
  logger.info(`   left_at:    ${report.left_at}`);
  logger.info(`   utterances heard:  ${report.utterances_received}`);
  logger.info(`   utterances spoken: ${report.utterances_spoken}`);
  logger.info(`   ended_by_timeout:  ${report.ended_by_timeout}`);
}

const isDirect = process.argv[1] && /meeting_participate\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { main as runMeetingParticipate };
