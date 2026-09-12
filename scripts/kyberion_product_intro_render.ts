#!/usr/bin/env tsx
/**
 * Local Kyberion product-intro render (no publish).
 * Bypasses the catalog-backed pipeline wrap that feeds `{type,op,params}` into
 * voice/video handleAction schemas which expect `{action,...}` / `{action,params}`.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeExec, safeMkdir } from '@agent/core/secure-io';
import { handleAction as handleVoiceAction } from '../libs/actuators/voice-actuator/src/index.js';
import { handleAction as handleVideoAction } from '../libs/actuators/video-composition-actuator/src/index.js';
import { defineScript, isDirectScript } from './lib/harness.js';

const OUT_DIR = 'active/shared/tmp/kyberion-intro';
const NARRATION_PATH = `${OUT_DIR}/kyberion-product-intro.aiff`;
const VIDEO_PATH = `${OUT_DIR}/kyberion-product-intro.mp4`;
const BUNDLE_DIR = `${OUT_DIR}/video-composition/kyberion-product-intro`;

const VOICE_SCRIPT =
  'Kyberionは曖昧な指示をそのまま実行しません。まず人間と意図を合意し、検証可能な活動定義に変換します。そのうえで安全なサンドボックスでタスクを実行し、実行ログと成果物の系統関係をエビデンスとして残します。さらに Quality Gate による多層検証で、成果物の信頼性と再現性を高めます。さあ、Kyberionを動かして、自律オペレーションを始めましょう。';

const HOOK = 'Kyberionは曖昧な指示をそのまま実行しません。';
const FEATURE =
  '意図を合意し、検証可能な活動定義に変換してから、安全なサンドボックスで実行。Trace と Quality Gate で再現性を担保します。';
const CTA = 'さあ、Kyberionを動かして自律オペレーションを始めましょう。';

async function main() {
  const outAbs = pathResolver.rootResolve(OUT_DIR);
  safeMkdir(outAbs, { recursive: true });

  console.log('[kyberion-intro] generating narration…');
  const voice = await handleVoiceAction({
    action: 'generate_voice',
    request_id: 'kyberion-product-intro-audio',
    text: VOICE_SCRIPT,
    profile_ref: { profile_id: 'operator-ja-default' },
    engine: { engine_id: 'local_say' },
    rendering: {
      language: 'ja',
      chunking: {
        max_chunk_chars: 4000,
        crossfade_ms: 50,
        preserve_paralinguistic_tags: true,
      },
    },
    delivery: {
      mode: 'artifact',
      format: 'aiff',
      artifact_path: NARRATION_PATH,
      emit_progress_packets: true,
    },
    routing: { personal_voice_mode: 'allow_fallback' },
  } as any);

  if (!safeExistsSync(pathResolver.rootResolve(NARRATION_PATH))) {
    throw new Error(`Narration missing after voice render: ${NARRATION_PATH}`);
  }
  console.log('[kyberion-intro] narration ready:', NARRATION_PATH, voice?.status || '');

  const narrationDuration = Number(
    safeExec(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        pathResolver.rootResolve(NARRATION_PATH),
      ],
      { cwd: pathResolver.rootDir(), timeoutMs: 30_000 }
    ).trim()
  );
  const durationSec = Math.max(
    10,
    Math.min(60, Number.isFinite(narrationDuration) ? Math.ceil(narrationDuration) : 35)
  );

  console.log(`[kyberion-intro] composing video (${durationSec}s)…`);
  const video = await handleVideoAction({
    action: 'create_narrated_intro_movie',
    params: {
      narrated_video_brief: {
        kind: 'narrated-video-brief',
        version: '1.0.0',
        title: 'Kyberion: 自律オペレーションへの招待',
        language: 'ja',
        script: { hook: HOOK, feature: FEATURE, cta: CTA },
        narration: { artifact_ref: NARRATION_PATH },
        design_system: {
          brand_name: 'Kyberion',
          theme_tokens: {
            background_color: '#0B1220',
            layout_variant: 'focus-center',
          },
        },
        timing: { duration_sec: durationSec, fps: 15 },
        output: {
          format: 'mp4',
          target_path: VIDEO_PATH,
          bundle_dir: BUNDLE_DIR,
          await_completion: true,
        },
      },
    },
  } as any);

  if (!safeExistsSync(pathResolver.rootResolve(VIDEO_PATH))) {
    throw new Error(
      `Video missing after composition: ${VIDEO_PATH} (status=${video?.status || 'unknown'})`
    );
  }
  console.log('[kyberion-intro] video ready:', VIDEO_PATH, video?.status || '');

  console.log('[kyberion-intro] verifying streams via ffprobe…');
  const probe = safeExec(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size',
      '-show_entries',
      'stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      pathResolver.rootResolve(VIDEO_PATH),
    ],
    { cwd: pathResolver.rootDir(), timeoutMs: 30_000 }
  );
  const probeJson = JSON.parse(probe) as {
    streams?: Array<{ codec_type?: string }>;
    format?: { duration?: string; size?: string };
  };
  const hasVideo = (probeJson.streams || []).some((s) => s.codec_type === 'video');
  const hasAudio = (probeJson.streams || []).some((s) => s.codec_type === 'audio');
  if (!hasVideo || !hasAudio) {
    throw new Error(`Rendered artifact missing streams (video=${hasVideo}, audio=${hasAudio})`);
  }

  console.log(
    JSON.stringify(
      {
        status: 'succeeded',
        narration_path: NARRATION_PATH,
        video_output_path: VIDEO_PATH,
        video_bundle_dir: BUNDLE_DIR,
        duration_sec: durationSec,
        voice_status: voice?.status,
        video_status: video?.status,
        probe: probeJson,
      },
      null,
      2
    )
  );
}

const script = defineScript({
  name: 'kyberion-product-intro-render',
  run: () => main(),
});
if (
  isDirectScript(import.meta.url, 'kyberion_product_intro_render.ts') ||
  isDirectScript(import.meta.url, 'kyberion_product_intro_render.js')
) {
  void script();
}
