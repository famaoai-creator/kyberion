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
  installShellSpeechToTextBridgeIfAvailable,
  logger,
  probeMicCapture,
  startInRoomMinutesSession,
} from '@agent/core';

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
    logger.error(`❌ マイクキャプチャを開始できません: ${probe.reason}`);
    return 1;
  }
  installShellSpeechToTextBridgeIfAvailable();

  logger.info(
    `🎙️  録音を開始します (mission: ${missionId.toUpperCase()}, backend: ${probe.backend})`
  );
  logger.info('   Ctrl-C で録音を終了し、議事録を生成します。');

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
    logger.info('⏹  録音を終了し、議事録を生成しています…');
    try {
      const result = await session.stop();
      logger.success(
        `✅ 完了: セグメント${result.segments}件 → transcript: ${result.transcriptPath}` +
          (result.minutesPath
            ? ` / 議事録: ${result.minutesPath}`
            : ' （音声が短すぎたため議事録は未生成）')
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
