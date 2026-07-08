#!/usr/bin/env node
/**
 * `pnpm check:apple-fm` — is on-device Apple Intelligence usable here, and
 * does a real round trip work? Read-only demo of the local assist layer
 * (libs/core/apple-intelligence-bridge.ts).
 */
import {
  classifyLocallyWithAppleFm,
  generateImageLocallyWithApplePlayground,
  probeAppleIntelligence,
  recognizeImageLocallyWithAppleVision,
  summarizeLocallyWithAppleFm,
  transcribeAudioLocallyWithAppleSpeech,
} from '@agent/core';
import { safeExistsSync } from '@agent/core';

async function main(): Promise<void> {
  const availability = await probeAppleIntelligence();
  console.log(`[check:apple-fm] availability: ${JSON.stringify(availability)}`);
  if (!availability.available) {
    console.log('[check:apple-fm] on-device model not usable here — all helpers degrade to null.');
    return;
  }

  const category = await classifyLocallyWithAppleFm('今週の進捗レポートを作って', [
    'document_production',
    'code_change',
    'research',
    'operations',
  ]);
  console.log(`[check:apple-fm] sample intent classification: ${category}`);

  const summary = await summarizeLocallyWithAppleFm(
    'ミッションでLP作成・デッキ作成・iOSアプリ検証を完了。レビュー1件が rework 指定。次はデザイン修正を行う。'
  );
  console.log(`[check:apple-fm] sample summary: ${summary}`);

  const sampleImage = 'docs/assets/kyberion-social-preview.png';
  if (safeExistsSync(sampleImage)) {
    const vision = await recognizeImageLocallyWithAppleVision(sampleImage);
    console.log(
      `[check:apple-fm] sample vision OCR: ${vision ? JSON.stringify(vision.text.split('\n')[0]) : 'null'}`
    );
  }

  const sampleAudio = process.env.KYBERION_APPLE_FM_SAMPLE_AUDIO;
  if (sampleAudio && safeExistsSync(sampleAudio)) {
    const transcript = await transcribeAudioLocallyWithAppleSpeech(sampleAudio);
    console.log(`[check:apple-fm] sample transcription: ${transcript}`);
  } else {
    console.log(
      '[check:apple-fm] transcription: set KYBERION_APPLE_FM_SAMPLE_AUDIO=<path> to demo (e.g. say -o /tmp/s.aiff "テスト")'
    );
  }

  const imagined = await generateImageLocallyWithApplePlayground(
    'abstract orbit emblem on a dark background',
    'active/shared/tmp/apple-fm-imagine-sample.png'
  );
  console.log(
    `[check:apple-fm] image generation: ${imagined ? `${imagined.path} (${imagined.style})` : 'unavailable on this device (Image Playground not enabled) — helpers degrade to null'}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
