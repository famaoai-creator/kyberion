#!/usr/bin/env node
/**
 * minutes:record — マイク録音から自動議事録。
 *
 * Usage:
 *   pnpm minutes:record --mission <MISSION_ID> [--source mic|system|both | --device ":0"]
 *                       [--title "定例会議"] [--language ja] [--tenant <slug>] [--work-item <ID>]
 *                       [--meeting-series <calendar series id>] [--meeting-url <url>]
 *   pnpm minutes:record --check [--shape room|remote|hybrid]   # 取得元の事前チェック(録音しない)
 *
 * 取得元は会議の形で決める: room=mic(会議室の声はマイクに届く) /
 * remote=system(リモートの声はスピーカー出力=BlackHole)/ hybrid=both。
 * アプリ側のミュートは Mac 本体のマイク入力には効かない。
 *
 * Ctrl-C (SIGINT) で録音を終了し、meeting-followup パイプラインで
 * minutes.md + アクションアイテムを生成する。
 * 録音には voice consent (purpose=recording) が必要:
 *   pnpm meeting:consent grant --mission <MISSION_ID>
 * または、会議のシリーズ ID / URL を渡せば meeting.recording の常設許可でも録音できる。
 * STT バックエンドは KYBERION_STT_COMMAND / WhisperKit / MLX を
 * knowledge/product/orchestration/service-presets/whisper.json を参考に設定。
 */

import {
  getSpeechToTextBridge,
  installAvailableSpeechToTextBridges,
} from '@agent/core/voice/speech-to-text-bridge';
import { installAppleSpeechToTextBridgeIfAvailable } from '@agent/core/apple-intelligence-bridge';
import { installAppleSpeechFileToTextBridgeIfAvailable } from '@agent/core/apple-speech-file-stt-bridge';
import { logger } from '@agent/core/core';
import {
  detectMacAudioListing,
  listMacAudioDevices,
  probeMicCapture,
  recommendCaptureSource,
  resolveMacCaptureSource,
  type MeetingShape,
  type MicCaptureSource,
} from '@agent/core/mic-capture';
import { startInRoomMinutesSession } from '@agent/core/in-room-minutes-recorder';
import { t as catalogT } from '@agent/core/t';
import { getRegisteredEnvText, setRegisteredEnv } from '@agent/core/foundation';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  setProcessExitCode,
} from './lib/harness.js';
import { hasCliFlag } from './lib/cli-guard.js';

function getFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const SOURCES: readonly MicCaptureSource[] = ['mic', 'system', 'both'];
const SHAPES: readonly MeetingShape[] = ['room', 'remote', 'hybrid'];

function pick<T extends string>(value: string | undefined, allowed: readonly T[], flag: string) {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    logger.error(
      `❌ ${catalogT('minutes_record:flag_invalid', { flag, value })} (${allowed.join('|')})`
    );
    throw new ScriptExitError(1, '', true);
  }
  return value as T;
}

/** Preflight: list the inputs and recommend a source. Never starts a recording. */
function printSourceCheck(shape: MeetingShape | undefined): void {
  if (process.platform !== 'darwin') {
    logger.warn(`⚠️  ${catalogT('minutes_record:source_check_macos_only')}`);
    return;
  }
  const listing = detectMacAudioListing();
  const devices = listMacAudioDevices(listing);
  for (const d of devices) {
    logger.info(`  ${d.device}  ${d.name}  [${d.virtual ? 'virtual' : 'physical'}]`);
  }
  const shapes = shape ? [shape] : SHAPES;
  for (const s of shapes) {
    const source = recommendCaptureSource(s);
    let resolved: string;
    try {
      resolved = resolveMacCaptureSource(listing, source).join(' + ');
    } catch (error) {
      resolved = error instanceof Error ? error.message : String(error);
    }
    logger.info(`  ${s} → --source ${source}  (${resolved})`);
  }
  logger.info(`  ${catalogT('minutes_record:source_check_hint')}`);
}

async function main(argv: string[] = []): Promise<void> {
  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'mission_controller');
  }
  const shape = pick(getFlag(argv, '--shape'), SHAPES, '--shape');
  if (hasCliFlag(argv, '--check')) {
    printSourceCheck(shape);
    return;
  }
  const source = pick(getFlag(argv, '--source'), SOURCES, '--source');
  const missionId = getFlag(argv, '--mission');
  if (!missionId) {
    logger.error(
      'Usage: pnpm minutes:record --mission <MISSION_ID> [--source mic|system|both | --device ":0"] [--title "..."] [--language ja] [--tenant <slug>] [--work-item <ID>]   |   pnpm minutes:record --check [--shape room|remote|hybrid]'
    );
    throw new ScriptExitError(1, '', true);
  }

  const probe = probeMicCapture();
  if (!probe.available) {
    logger.error(`❌ ${catalogT('minutes_record:mic_capture_failed', { reason: probe.reason })}`);
    throw new ScriptExitError(1, '', true);
  }
  // Register available local backends; the seam selects by catalog priority.
  // Apple's native recognizers are asynchronous probes, so they are added
  // only when no synchronous backend registered above.
  installAvailableSpeechToTextBridges();
  let sttBackend = getSpeechToTextBridge().name !== 'stub' ? getSpeechToTextBridge().name : null;
  if (!sttBackend && (await installAppleSpeechToTextBridgeIfAvailable())) {
    sttBackend = getSpeechToTextBridge().name;
  }
  if (!sttBackend && installAppleSpeechFileToTextBridgeIfAvailable()) {
    sttBackend = getSpeechToTextBridge().name;
  }
  if (!sttBackend) {
    logger.warn(`⚠️  ${catalogT('minutes_record:stt_unavailable')}`);
  }

  logger.info(
    `🎙️  ${catalogT('minutes_record:recording_started', {
      missionId: missionId.toUpperCase(),
      backend: probe.backend,
      stt: sttBackend ?? 'none (stub)',
    })}`
  );
  logger.info('   Ctrl-C to stop recording and generate minutes.');

  const meetingUrl = getFlag(argv, '--meeting-url');
  const meetingSeries = getFlag(argv, '--meeting-series');
  const session = await startInRoomMinutesSession({
    missionId,
    ...(meetingUrl || meetingSeries
      ? {
          meeting: {
            ...(meetingUrl ? { url: meetingUrl } : {}),
            ...(meetingSeries ? { series_id: meetingSeries } : {}),
          },
        }
      : {}),
    meetingTitle: getFlag(argv, '--title'),
    language: getFlag(argv, '--language') || 'ja',
    mic: { device: getFlag(argv, '--device'), source },
    tenantSlug: getFlag(argv, '--tenant'),
    workItemId: getFlag(argv, '--work-item'),
    onSilenceWarning: ({ seconds }) => {
      logger.warn(`⚠️  ${catalogT('minutes_record:silence_warning', { seconds })}`);
    },
    onTranscriptChunk: (chunk) => {
      logger.info(`📝 [${chunk.segment}] ${chunk.text}`);
    },
  });

  let stopping = false;
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    logger.info(`⏹  ${catalogT('minutes_record:recording_stopping')}`);
    try {
      const result = await session.stop();
      const minutes = result.minutesPath
        ? catalogT('minutes_record:recording_minutes_path', { path: result.minutesPath })
        : catalogT('minutes_record:recording_short');
      logger.success(
        `✅ ${catalogT('minutes_record:recording_complete', {
          segments: result.segments,
          transcript: result.transcriptPath,
          minutes,
        })}`
      );
      setProcessExitCode(0);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      setProcessExitCode(1);
    }
  };
  process.on('SIGINT', () => void finish());
  process.on('SIGTERM', () => void finish());

  await session.done;
  await finish();
}

export const runMinutesRecord = defineScript({
  name: 'minutes:record',
  flags: [],
  run: async ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'minutes_record.ts') ||
  isDirectScript(import.meta.url, 'minutes_record.js')
)
  void runMinutesRecord();
