import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  pathResolver,
  resetCurrentScope,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
  validateReadPermission,
} from '@agent/core';
import {
  indexMedia,
  type SemanticEmbeddingProvider,
  type SemanticIndexOptions,
} from '@agent/core/perception/semantic-index';
import {
  dropDuplicateFrames,
  parseFfprobeMetadata,
  runWatchCommand,
  WATCH_USAGE,
} from './cli-watch.js';
import { createFakeDeps, fakeBridge, guardedReadBridge } from './lib/perception.test-support.js';

// Tier-guard denials emit best-effort audit events; keep them off the real
// audit chain so the suite stays hermetic. Partial mock: the @agent/core
// barrel loads audit-forwarder, which registers a publisher at import time.
vi.mock('@agent/core/governance/audit-chain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/audit-chain')>();
  return { ...actual, auditChain: { ...actual.auditChain, record: vi.fn() } };
});

const PROBE_WITH_AUDIO = JSON.stringify({
  format: { duration: '30.0' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});
const PROBE_SILENT = JSON.stringify({
  format: { duration: '4.0' },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }],
});

describe('pnpm kyberion watch', () => {
  let workDir = '';
  let videoPath = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-watch-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    videoPath = path.join(workDir, 'demo.mp4');
    // R04: the fixture must carry a real container signature (ISO-BMFF ftyp),
    // not 'fake-video' — watch now sniffs input bytes before spawning ffmpeg.
    safeWriteFile(videoPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]));
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('prints metadata, transcript and a de-duplicated OCR timeline, then cleans scratch', async () => {
    const texts = ['Title slide', 'Title  slide', 'Agenda'];
    const deps = createFakeDeps({
      ffprobe: PROBE_WITH_AUDIO,
      frameCount: 3,
      ocrText: (p) => texts[Number(/frame-(\d{4})/.exec(p)![1]) - 1]!,
      bridges: [
        fakeBridge('seg', { text: 'hi', segments: [{ start_sec: 1, end_sec: 3, text: 'hi' }] }),
      ],
    });
    const output: string[] = [];
    const result = await runWatchCommand(
      [path.relative(pathResolver.rootDir(), videoPath), '--every', '10'],
      (t) => output.push(t),
      deps
    );
    const printed = output.join('\n');
    expect(printed).toContain('- resolution: 1280×720 (h264)');
    expect(printed).toContain('## Transcript');
    expect(printed).toContain('[00:01–00:03] hi');
    expect(printed).toContain('### 00:00\n\nTitle slide');
    expect(printed).not.toContain('### 00:10');
    expect(printed).toContain('### 00:20\n\nAgenda');
    expect(printed).toContain('> [watch] 1 near-duplicate frame(s) omitted');
    expect(result?.frames.map((f) => f.time_sec)).toEqual([0, 20]);
    const frameCall = deps.calls.find((c) => c.tool === 'ffmpeg' && c.args.includes('-vf'))!;
    expect(frameCall.args).toEqual(expect.arrayContaining(['fps=1/10', '-frames:v', '24']));
    const scratch = path.dirname(path.dirname(frameCall.args[frameCall.args.length - 1]!));
    expect(scratch.startsWith(pathResolver.sharedTmp())).toBe(true);
    expect(safeExistsSync(scratch)).toBe(false);
  });

  it('spreads --max-frames over the duration by default and keeps frames with --frames', async () => {
    const framesDir = path.join(workDir, 'kept');
    const deps = createFakeDeps({ ffprobe: PROBE_SILENT, frameCount: 2 });
    const output: string[] = [];
    const result = await runWatchCommand(
      [videoPath, '--max-frames', '2', '--frames', framesDir, '--no-ocr'],
      (t) => output.push(t),
      deps
    );
    expect(result?.every_sec).toBe(2);
    expect(safeReaddir(framesDir).sort()).toEqual(['frame-0001.png', 'frame-0002.png']);
    const printed = output.join('\n');
    expect(printed).toContain(
      `frame: ${path.relative(pathResolver.rootDir(), path.join(framesDir, 'frame-0001.png'))}`
    );
    expect(printed).toContain('> [watch] video has no audio stream; no transcript');
    expect(printed).toContain('> [watch] sampling capped at 2 frames');
    expect(deps.ocrPaths).toEqual([]);
  });

  it('warns (does not fail) when no speech backend is installed', async () => {
    const output: string[] = [];
    await runWatchCommand(
      [videoPath],
      (t) => output.push(t),
      createFakeDeps({ ffprobe: PROBE_WITH_AUDIO })
    );
    expect(output.join('\n')).toMatch(
      /> \[watch\] no transcript: no speech-to-text backend[\s\S]*voice setup/
    );
  });

  it('turns a missing ffmpeg into the install instruction', async () => {
    await expect(
      runWatchCommand([videoPath], () => {}, createFakeDeps({ missingFfmpeg: true }))
    ).rejects.toThrow(/brew install ffmpeg/);
  });

  it('refuses outside-repo input and frames dirs, unsupported types, bad numbers, and prints usage', async () => {
    await expect(
      runWatchCommand(['/Users/someone/Downloads/a.mp4'], () => {}, createFakeDeps())
    ).rejects.toThrow(/outside the repository[\s\S]*active\/shared\/tmp/);
    await expect(
      runWatchCommand([videoPath, '--frames', '/Users/someone/frames'], () => {}, createFakeDeps())
    ).rejects.toThrow(/--frames .* must be a directory inside the repository/);
    await expect(
      runWatchCommand([path.join(workDir, 'a.wav')], () => {}, createFakeDeps())
    ).rejects.toThrow(/unsupported file type[\s\S]*kyberion listen/);
    await expect(
      runWatchCommand([videoPath, '--every', '0'], () => {}, createFakeDeps())
    ).rejects.toThrow(/--every requires a positive number/);
    await expect(runWatchCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion watch/);
    const output: string[] = [];
    await runWatchCommand(['--help'], (t) => output.push(t));
    expect(output[0]).toBe(WATCH_USAGE);
  });

  it('parses ffprobe JSON and drops only consecutive near-duplicates', () => {
    expect(parseFfprobeMetadata(PROBE_SILENT)).toEqual({
      duration_sec: 4,
      width: 320,
      height: 240,
      video_codec: 'h264',
      has_audio: false,
    });
    const frames = [
      { time_sec: 0, text: 'A' },
      { time_sec: 1, text: 'B' },
      { time_sec: 2, text: 'A' },
    ];
    expect(dropDuplicateFrames(frames)).toHaveLength(3);
  });
});

const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_TIER',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_SCOPE_ENV_PATH',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;

const TENANT = 'acme-corp';

/** Deterministic local embedder — the CLI only forwards it to the real index op. */
const fakeEmbeddingProvider: SemanticEmbeddingProvider = {
  identity: 'test-embedder-v1',
  embed: async (inputs) => inputs.map(() => [1, 0]),
};

describe('pnpm kyberion watch under a persisted confidential tenant scope', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // The interactive-CLI identity: persisted tier + tenant, no claim, no
    // role, persona resolves to 'unknown'.
    process.env.KYBERION_TIER = 'confidential';
    process.env.KYBERION_TENANT = TENANT;
    // currentScope() is process-cached; drop any scope resolved under a
    // different env so the semantic-index scope check sees this binding.
    resetCurrentScope();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('lists and OCRs scratch frames, transcribes audio, and keeps --frames on a protected floor', async () => {
    const staged = path.join(
      pathResolver.rootDir(),
      `active/shared/staging/confidential/${TENANT}/watch-${randomUUID()}`
    );
    safeMkdir(staged, { recursive: true });
    const video = path.join(staged, 'demo.mp4');
    safeWriteFile(video, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]));
    const keptDir = path.join(
      pathResolver.rootDir(),
      `active/shared/tmp/confidential/${TENANT}/watch-kept-${randomUUID()}`
    );
    // assertPerceptionOutput authenticates the tenant through the existing
    // destination dir on protected tiers — create it first.
    safeMkdir(keptDir, { recursive: true });
    try {
      // Before-state: the grant-less interactive identity cannot even read
      // the input it staged — the residual ROLE_VIOLATION class.
      expect(() => safeLstat(video)).toThrow(/ROLE_VIOLATION/);
      const texts = ['Alpha title', 'Bravo agenda', 'Charlie summary'];
      const deps = createFakeDeps({
        ffprobe: PROBE_WITH_AUDIO,
        frameCount: 3,
        guardedReads: true, // reproduces ocrImage's lstat+read of each frame
        ocrText: (p) => texts[Number(/frame-(\d{4})/.exec(p)![1]) - 1]!,
        bridges: [guardedReadBridge('guarded-stt')],
      });
      const result = await runWatchCommand(
        [video, '--every', '10', '--frames', keptDir],
        () => {},
        deps
      );
      // Frame listing + per-frame OCR + transcript ran under the media role;
      // the kept-frame destination write stayed under the caller's identity.
      expect(result?.transcript?.text).toBe('hello world');
      expect(result?.frames).toHaveLength(3);
      expect(result?.frames.map((f) => f.path)).toEqual([
        path.relative(pathResolver.rootDir(), path.join(keptDir, 'frame-0001.png')),
        path.relative(pathResolver.rootDir(), path.join(keptDir, 'frame-0002.png')),
        path.relative(pathResolver.rootDir(), path.join(keptDir, 'frame-0003.png')),
      ]);
      expect(deps.ocrPaths).toHaveLength(3);
    } finally {
      safeRmSync(staged, { recursive: true, force: true });
      safeRmSync(keptDir, { recursive: true, force: true });
    }
  });

  it('still refuses an input on another tenant partition before any role runs', async () => {
    const staged = path.join(
      pathResolver.rootDir(),
      `active/shared/staging/confidential/other-co/watch-${randomUUID()}`
    );
    const video = path.join(staged, 'demo.mp4');
    // The bound acme-corp identity may not even write the foreign partition —
    // stage the fixture unscoped, then rebind for the command itself.
    delete process.env.KYBERION_TENANT;
    try {
      safeMkdir(staged, { recursive: true });
      safeWriteFile(video, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]));
    } finally {
      process.env.KYBERION_TENANT = TENANT;
    }
    try {
      await expect(
        runWatchCommand([video], () => {}, createFakeDeps({ guardedReads: true }))
      ).rejects.toThrow(/PERCEPTION_SCOPE/);
    } finally {
      delete process.env.KYBERION_TENANT;
      try {
        safeRmSync(staged, { recursive: true, force: true });
      } finally {
        process.env.KYBERION_TENANT = TENANT;
      }
    }
  });

  it('indexes sampled frames into the own-tenant cache index under the media role', async () => {
    const staged = path.join(
      pathResolver.rootDir(),
      `active/shared/staging/confidential/${TENANT}/watch-${randomUUID()}`
    );
    safeMkdir(staged, { recursive: true });
    const video = path.join(staged, 'demo.mp4');
    safeWriteFile(video, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]));
    const indexId = `watch${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
    const indexPath = path.join(
      pathResolver.rootDir(),
      `active/shared/cache/confidential/${TENANT}/perception/semantic/${indexId}.json`
    );
    try {
      // Before-state: the grant-less interactive identity cannot read the
      // cache-floor index subtree — the residual this change fixes.
      expect(validateReadPermission(indexPath).allowed).toBe(false);
      const deps = createFakeDeps({
        ffprobe: PROBE_SILENT,
        frameCount: 2,
        guardedReads: true,
      });
      deps.enhancements = {
        index: (options: SemanticIndexOptions) =>
          indexMedia(options, { provider: fakeEmbeddingProvider }),
      };
      const result = await runWatchCommand(
        [video, '--index', indexId, '--embedding-model', 'unused-fake-model'],
        () => {},
        deps
      );
      expect(result?.index).toMatchObject({
        index_id: indexId,
        entries: 2,
        provider: 'test-embedder-v1',
      });
      // The interactive identity outside the wrap still cannot read it.
      expect(validateReadPermission(indexPath).allowed).toBe(false);
      expect(() => safeLstat(indexPath)).toThrow();
    } finally {
      safeRmSync(staged, { recursive: true, force: true });
      safeRmSync(indexPath, { force: true });
    }
  });
});
