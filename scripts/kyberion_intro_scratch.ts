#!/usr/bin/env tsx
/**
 * Scratch-first narrated intro (default discovery path).
 *
 * Standard flow:
 *   1) Iterate here until the picture/VO are accepted
 *   2) Promote into a governed narrated-video pipeline only after acceptance
 *
 * See:
 *   knowledge/product/orchestration/narrated-video-production-playbook.md
 *   knowledge/product/orchestration/scratch-to-pipeline-video-promotion.md
 *
 * Technique: custom HTML scenes → Playwright stills → say narration → ffmpeg assemble.
 * This file intentionally does NOT call video-composition ADF / create_narrated_intro_movie.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeExec, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

const OUT = 'active/shared/tmp/kyberion-intro-scratch';
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

const NARRATION = [
  {
    id: 'brand',
    seconds: 4,
    say: 'Kyberion。',
    title: 'KYBERION',
    line: '自律オペレーションのための実行基盤',
  },
  {
    id: 'hook',
    seconds: 7,
    say: '曖昧な指示は、そのまま実行しません。',
    title: '曖昧な指示は実行しない',
    line: 'まず人間と意図を合意する',
  },
  {
    id: 'process',
    seconds: 12,
    say: '意図を合意し、検証可能な活動定義に変換してから、安全なサンドボックスで実行します。Trace と Quality Gate が再現性を支えます。',
    title: '意図 → 契約 → 実行',
    line: '合意・実行・検証のサイクル',
    steps: ['意図の合意', '活動定義へ変換', 'サンドボックス実行', 'Trace / Quality Gate'],
  },
  {
    id: 'cta',
    seconds: 7,
    say: 'さあ、Kyberion を動かして、自律オペレーションを始めましょう。',
    title: '今すぐ始める',
    line: 'ミッションとして動かし、証拠を残す',
  },
] as const;

function sceneHtml(scene: (typeof NARRATION)[number], index: number): string {
  const steps =
    'steps' in scene && Array.isArray(scene.steps)
      ? scene.steps
          .map(
            (label, i) => `
            <div class="step">
              <span class="n">${String(i + 1).padStart(2, '0')}</span>
              <strong>${escape(label)}</strong>
            </div>`
          )
          .join('')
      : '';

  const variant = scene.id;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  @font-face { font-family: 'Display'; src: local('Avenir Next'), local('Hiragino Sans'), local('Helvetica Neue'); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
    font-family: 'Display', 'Hiragino Sans', 'Noto Sans JP', sans-serif;
    color: #f4efe6;
    background: #0a0c10;
  }
  .stage {
    position: relative; width: 100%; height: 100%;
    background:
      radial-gradient(ellipse 80% 60% at 15% 20%, rgba(232, 145, 58, 0.18), transparent 55%),
      radial-gradient(ellipse 70% 50% at 85% 75%, rgba(56, 189, 248, 0.12), transparent 50%),
      linear-gradient(160deg, #0a0c10 0%, #12161f 45%, #0d1118 100%);
  }
  .grain {
    position: absolute; inset: 0; opacity: 0.08; pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
  }
  .frame {
    position: absolute; inset: 48px;
    border: 1px solid rgba(244, 239, 230, 0.08);
    display: flex; flex-direction: column; justify-content: center;
    padding: 72px 88px;
  }
  .brand {
    position: absolute; top: 72px; left: 96px;
    letter-spacing: 0.42em; font-size: 14px; font-weight: 600;
    color: rgba(232, 145, 58, 0.95); text-transform: uppercase;
  }
  .index {
    position: absolute; top: 72px; right: 96px;
    font-size: 14px; letter-spacing: 0.2em; color: rgba(244,239,230,0.45);
  }
  h1 {
    font-size: ${variant === 'brand' ? '120px' : '72px'};
    line-height: 1.12; font-weight: 700; letter-spacing: ${variant === 'brand' ? '0.08em' : '-0.02em'};
    max-width: 14em;
  }
  .line {
    margin-top: 28px; font-size: 28px; line-height: 1.55;
    color: rgba(244, 239, 230, 0.72); max-width: 18em; font-weight: 400;
  }
  .steps {
    margin-top: 48px; display: grid; gap: 14px; max-width: 720px;
  }
  .step {
    display: grid; grid-template-columns: 64px 1fr; align-items: center;
    padding: 16px 20px; border-radius: 4px;
    background: rgba(255,255,255,0.03);
    border-left: 3px solid #e8913a;
  }
  .step .n {
    font-size: 18px; letter-spacing: 0.12em; color: #e8913a; font-weight: 700;
  }
  .step strong { font-size: 26px; font-weight: 600; }
  .bar {
    position: absolute; left: 96px; right: 96px; bottom: 72px; height: 2px;
    background: rgba(244,239,230,0.12);
  }
  .bar > i {
    display: block; height: 100%; width: ${((index + 1) / NARRATION.length) * 100}%;
    background: linear-gradient(90deg, #e8913a, #38bdf8);
  }
  .variant-brand h1 { color: #f4efe6; }
  .variant-hook h1 { color: #f4efe6; }
  .variant-process .frame { justify-content: flex-start; padding-top: 140px; }
  .variant-cta h1 { font-size: 88px; }
  .accent-orb {
    position: absolute; width: 520px; height: 520px; border-radius: 50%;
    right: -80px; top: 18%;
    background: radial-gradient(circle, rgba(232,145,58,0.22), transparent 68%);
    filter: blur(8px);
  }
</style>
</head>
<body>
  <div class="stage variant-${escape(variant)}">
    <div class="grain"></div>
    <div class="accent-orb"></div>
    <div class="brand">Kyberion</div>
    <div class="index">${String(index + 1).padStart(2, '0')} / ${String(NARRATION.length).padStart(2, '0')}</div>
    <div class="frame">
      <h1>${escape(scene.title)}</h1>
      <p class="line">${escape(scene.line)}</p>
      ${steps ? `<div class="steps">${steps}</div>` : ''}
    </div>
    <div class="bar"><i></i></div>
  </div>
</body>
</html>`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function captureScenes(rootAbs: string): Promise<string[]> {
  const scenesDir = path.join(rootAbs, 'scenes');
  const framesDir = path.join(rootAbs, 'frames');
  safeMkdir(scenesDir, { recursive: true });
  safeMkdir(framesDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  const framePaths: string[] = [];
  for (let i = 0; i < NARRATION.length; i += 1) {
    const scene = NARRATION[i];
    const htmlRel = `${OUT}/scenes/${scene.id}.html`;
    const pngRel = `${OUT}/frames/${String(i + 1).padStart(2, '0')}-${scene.id}.png`;
    safeWriteFile(pathResolver.rootResolve(htmlRel), sceneHtml(scene, i), { encoding: 'utf8' });
    const fileUrl = pathToFileURL(pathResolver.rootResolve(htmlRel)).href;
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    await page.screenshot({
      path: pathResolver.rootResolve(pngRel),
      type: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    framePaths.push(pngRel);
    console.log(`[scratch] frame ${scene.id}`);
  }
  await browser.close();
  return framePaths;
}

function synthesizeNarration(rootAbs: string): {
  wavPath: string;
  segments: Array<{ id: string; seconds: number }>;
} {
  const audioDir = path.join(rootAbs, 'audio');
  safeMkdir(audioDir, { recursive: true });
  const parts: string[] = [];
  const segments: Array<{ id: string; seconds: number }> = [];

  for (const scene of NARRATION) {
    const aiff = path.join(audioDir, `${scene.id}.aiff`);
    const wav = path.join(audioDir, `${scene.id}.wav`);
    safeExec('say', ['-v', 'Kyoko', '-o', aiff, scene.say], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
    });
    safeExec('ffmpeg', ['-y', '-i', aiff, '-ar', '44100', '-ac', '1', wav], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
    });
    const dur = Number(
      safeExec(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', wav],
        { cwd: pathResolver.rootDir(), timeoutMs: 30_000 }
      ).trim()
    );
    const seconds = Math.max(
      scene.seconds,
      Number.isFinite(dur) ? Math.ceil(dur) + 0.4 : scene.seconds
    );
    segments.push({ id: scene.id, seconds });
    parts.push(wav);
    console.log(`[scratch] voice ${scene.id} (~${seconds.toFixed(1)}s)`);
  }

  // Pad/concat with soft gaps via ffmpeg concat demuxer of wavs + silence pads
  const listFile = path.join(audioDir, 'concat.txt');
  const listBody: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const target = segments[i].seconds;
    const padded = path.join(audioDir, `${NARRATION[i].id}-pad.wav`);
    safeExec(
      'ffmpeg',
      [
        '-y',
        '-i',
        parts[i],
        '-af',
        `apad=whole_dur=${target.toFixed(2)}`,
        '-ar',
        '44100',
        '-ac',
        '1',
        padded,
      ],
      { cwd: pathResolver.rootDir(), timeoutMs: 60_000 }
    );
    listBody.push(`file '${padded.replace(/'/g, "'\\''")}'`);
  }
  safeWriteFile(listFile, `${listBody.join('\n')}\n`, { encoding: 'utf8' });
  const outWav = path.join(audioDir, 'narration.wav');
  safeExec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outWav], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 60_000,
  });
  return { wavPath: `${OUT}/audio/narration.wav`, segments };
}

function assembleVideo(
  framePaths: string[],
  segments: Array<{ id: string; seconds: number }>,
  wavRel: string
) {
  const clipsDir = pathResolver.rootResolve(`${OUT}/clips`);
  safeMkdir(clipsDir, { recursive: true });
  const clipFiles: string[] = [];

  for (let i = 0; i < framePaths.length; i += 1) {
    const seconds = segments[i].seconds;
    const frames = Math.max(1, Math.round(seconds * FPS));
    const clip = path.join(clipsDir, `${String(i + 1).padStart(2, '0')}.mp4`);
    // Subtle push-in so stills are not frozen
    safeExec(
      'ffmpeg',
      [
        '-y',
        '-loop',
        '1',
        '-i',
        pathResolver.rootResolve(framePaths[i]),
        '-vf',
        `scale=${WIDTH * 1.08}:${HEIGHT * 1.08},zoompan=z='min(1.08,1+0.00035*on)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
        '-t',
        String(seconds),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'medium',
        '-crf',
        '18',
        clip,
      ],
      { cwd: pathResolver.rootDir(), timeoutMs: 180_000 }
    );
    clipFiles.push(clip);
    console.log(`[scratch] clip ${segments[i].id}`);
  }

  const videoList = pathResolver.rootResolve(`${OUT}/clips/concat.txt`);
  safeWriteFile(
    videoList,
    `${clipFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')}\n`,
    { encoding: 'utf8' }
  );
  const silent = pathResolver.rootResolve(`${OUT}/video-silent.mp4`);
  safeExec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', videoList, '-c', 'copy', silent], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 120_000,
  });

  const finalMp4 = pathResolver.rootResolve(`${OUT}/kyberion-intro-scratch.mp4`);
  safeExec(
    'ffmpeg',
    [
      '-y',
      '-i',
      silent,
      '-i',
      pathResolver.rootResolve(wavRel),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      finalMp4,
    ],
    { cwd: pathResolver.rootDir(), timeoutMs: 120_000 }
  );
  return `${OUT}/kyberion-intro-scratch.mp4`;
}

async function main() {
  const rootAbs = pathResolver.rootResolve(OUT);
  safeMkdir(rootAbs, { recursive: true });
  console.log('[scratch] capturing original scenes (no video pipeline)…');
  const frames = await captureScenes(rootAbs);
  console.log('[scratch] synthesizing narration…');
  const { wavPath, segments } = synthesizeNarration(rootAbs);
  console.log('[scratch] assembling mp4…');
  const out = assembleVideo(frames, segments, wavPath);
  if (!safeExistsSync(pathResolver.rootResolve(out))) {
    throw new Error(`missing output ${out}`);
  }
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
      pathResolver.rootResolve(out),
    ],
    { cwd: pathResolver.rootDir(), timeoutMs: 30_000 }
  );
  console.log(
    JSON.stringify({ status: 'succeeded', video: out, probe: JSON.parse(probe) }, null, 2)
  );
}

const script = defineScript({
  name: 'kyberion-intro-scratch',
  run: () => main(),
});
if (
  isDirectScript(import.meta.url, 'kyberion_intro_scratch.ts') ||
  isDirectScript(import.meta.url, 'kyberion_intro_scratch.js')
) {
  void script();
}
