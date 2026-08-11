#!/usr/bin/env node
/**
 * minutes:record — マイク録音から自動議事録。
 *
 * Usage:
 *   pnpm minutes:record --mission <MISSION_ID> [--device ":0"] [--title "定例会議"] [--language ja]
 *
 * Ctrl-C (SIGINT) で録音を終了し、meeting-followup パイプラインで
 * minutes.md + アクションアイテムを生成する。
 * 録音には voice consent (purpose=recording) が必要:
 *   pnpm meeting:consent grant --mission <MISSION_ID>
 * STT バックエンドは KYBERION_STT_COMMAND / WhisperKit / MLX を
 * knowledge/product/orchestration/service-presets/whisper.json を参考に設定。
 */

import {
  installAppleSpeechFileToTextBridgeIfAvailable,
  installAppleSpeechToTextBridgeIfAvailable,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installManagedMlxWhisperSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  logger,
  probeMicCapture,
  startInRoomMinutesSession,
} from '@agent/core';
import { t as catalogT } from '@agent/core/t';

function getFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<number> {
  process.env.MISSION_ROLE = process.env.MISSION_ROLE || 'mission_controller';
  const argv = process.argv.slice(2);
  const missionId = getFlag(argv, '--mission');
  if (!missionId) {
    logger.error(
      'Usage: pnpm minutes:record --mission <MISSION_ID> [--device ":0"] [--title "..."] [--language ja]'
    );
    return 1;
  }

  const probe = probeMicCapture();
  if (!probe.available) {
    logger.error(`❌ ${catalogT('minutes_record:mic_capture_failed', { reason: probe.reason })}`);
    return 1;
  }
  // Register every on-device STT backend, not just the shell one. Each
  // installer no-ops when a higher-priority backend is already configured, so
  // this is ordered best-first. Recording a whole meeting only to find the stub
  // was in charge is the expensive failure here, so say which one won up front.
  const sttBackend = installShellSpeechToTextBridgeIfAvailable()
    ? 'shell (KYBERION_STT_COMMAND)'
    : installFluidAudioSpeechToTextBridgeIfAvailable()
      ? 'fluid-audio-parakeet'
      : installManagedMlxWhisperSpeechToTextBridgeIfAvailable()
        ? 'mlx_whisper'
        : // Apple's on-device recognizers need no install and no model
          // download. SpeechAnalyzer first (better output, macOS 26+), then
          // SFSpeechRecognizer, which covers every macOS back to 10.15.
          (await installAppleSpeechToTextBridgeIfAvailable())
          ? 'apple-speech'
          : installAppleSpeechFileToTextBridgeIfAvailable()
            ? 'apple-speech-file'
            : null;
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

  const session = await startInRoomMinutesSession({
    missionId,
    meetingTitle: getFlag(argv, '--title'),
    language: getFlag(argv, '--language') || 'ja',
    mic: { device: getFlag(argv, '--device') },
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
      process.exit(0);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void finish());
  process.on('SIGTERM', () => void finish());

  await session.done;
  await finish();
  return 0;
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
