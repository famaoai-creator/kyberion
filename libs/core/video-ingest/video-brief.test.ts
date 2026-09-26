import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { resolveYtDlpBin } from '../tool-binary-resolvers.js';
import type { EgressPolicyDecision } from '../egress-policy.js';
import type { RiskyApprovalRequest } from '../risky-op-approval-port.js';
import {
  assertNoTierDowngrade,
  buildVideoBrief,
  resolveVideoCachePlacement,
  tierOfPath,
  type BuildVideoBriefOptions,
  type VideoCachePlacement,
} from './video-brief.js';
import { classifyYtDlpFailure, loadVideoIngestPolicy, urlContentKey } from './video-fetch.js';
import { parseSceneTimes, planKeyframes } from './video-media.js';
import type {
  VideoCommandResult,
  VideoCommandRunner,
  VideoIngestPolicy,
} from './video-ingest-types.js';

const TEST_ROOT = pathResolver.sharedTmp(`video-ingest-tests/${randomUUID()}`);
const URL_ = 'https://www.youtube.com/watch?v=abc123&utm_source=share#t=10';

const POLICY: VideoIngestPolicy = {
  version: 'test',
  allowed_hosts: ['youtube.com', 'youtu.be'],
  max_duration_sec: 3600,
  max_bytes: 1024 * 1024,
  require_approval_for_remote: true,
  default_max_keyframes: 4,
  keyframe_interval_sec: 30,
  scene_threshold: 0.3,
  download_format: 'best',
};

const MANUAL_VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nmanual line\n';
const AUTO_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'auto one',
  '',
  '00:00:02.000 --> 00:00:04.000',
  'auto one',
  'auto two',
  '',
].join('\n');

interface FakeVideo {
  duration?: number;
  subtitles?: Record<string, string>;
  automatic_captions?: Record<string, string>;
  infoFailure?: string;
}

interface Call {
  command: string;
  args: string[];
}

function ok(stdout = '', stderr = ''): VideoCommandResult {
  return { stdout, stderr, status: 0 };
}

function fakeRunner(video: FakeVideo, calls: Call[]): VideoCommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === 'fake-yt-dlp' && args.includes('-J')) {
      if (video.infoFailure) return { stdout: '', stderr: video.infoFailure, status: 1 };
      const tracks = (map: Record<string, string> = {}) =>
        Object.fromEntries(Object.keys(map).map((lang) => [lang, [{ ext: 'vtt' }]]));
      return ok(
        JSON.stringify({
          title: 'Demo video',
          duration: video.duration ?? 90,
          uploader: 'Uploader',
          language: 'en',
          chapters: [
            { start_time: 0, end_time: 45, title: 'Intro' },
            { start_time: 45, end_time: 90, title: 'Main' },
          ],
          subtitles: tracks(video.subtitles),
          automatic_captions: tracks(video.automatic_captions),
        })
      );
    }
    if (command === 'fake-yt-dlp') {
      const template = args[args.indexOf('-o') + 1];
      const dir = path.dirname(template);
      safeWriteFile(path.join(dir, 'source.mp4'), 'media-bytes');
      const lang = args.includes('--sub-langs') ? args[args.indexOf('--sub-langs') + 1] : null;
      if (lang) {
        const body = args.includes('--write-subs')
          ? video.subtitles?.[lang]
          : video.automatic_captions?.[lang];
        if (body) safeWriteFile(path.join(dir, `source.${lang}.vtt`), body);
      }
      return ok();
    }
    if (command === 'fake-ffprobe') {
      return ok(
        JSON.stringify({
          format: { duration: '12.5', tags: { title: 'Local clip' } },
          chapters: [],
        })
      );
    }
    if (command === 'fake-ffmpeg' && args.includes('null')) {
      return ok('', '[Parsed_showinfo_1] n:0 pts:1 pts_time:20.5 duration:1\n');
    }
    return ok();
  };
}

function freshPlacement(): VideoCachePlacement {
  return { scope: 'shared', root: path.join(TEST_ROOT, randomUUID()), tier: 'public' };
}

const allowEgress = (): EgressPolicyDecision => ({
  verdict: 'allow',
  hostname: 'www.youtube.com',
  reason: 'test',
  mode: 'warn',
});

function options(overrides: Partial<BuildVideoBriefOptions> = {}): BuildVideoBriefOptions {
  return {
    policy: POLICY,
    cachePlacement: freshPlacement(),
    evaluateEgress: allowEgress,
    approval: { agent_id: 'test-agent' },
    requestApproval: () => ({ allowed: true, status: 'approved' }),
    bins: { yt_dlp: 'fake-yt-dlp', ffmpeg: 'fake-ffmpeg', ffprobe: 'fake-ffprobe' },
    transcribe: async () => null,
    ...overrides,
  };
}

afterAll(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildVideoBrief transcript priority', () => {
  it('prefers manual subtitles over automatic captions and STT', async () => {
    const calls: Call[] = [];
    const transcribe = vi.fn(async () => ({
      segments: [{ start_sec: 0, end_sec: 1, text: 'stt' }],
    }));
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        runner: fakeRunner(
          { subtitles: { en: MANUAL_VTT }, automatic_captions: { en: AUTO_VTT } },
          calls
        ),
        transcribe,
      })
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.brief.transcript).toEqual({
      origin: 'manual_subs',
      language: 'en',
      segments: [{ start_sec: 0, end_sec: 2, text: 'manual line' }],
    });
    expect(transcribe).not.toHaveBeenCalled();
    const download = calls.find((call) => call.args.includes('--write-subs'));
    expect(download?.args).toContain('--no-update');
    expect(outcome.brief.metadata).toMatchObject({ title: 'Demo video', duration_sec: 90 });
    expect(outcome.brief.chapters.map((chapter) => chapter.title)).toEqual(['Intro', 'Main']);
    expect(outcome.brief.keyframes.map((frame) => [frame.t_sec, frame.reason])).toEqual([
      [0, 'chapter'],
      [20.5, 'scene'],
      [30, 'interval'],
      [45, 'chapter'],
    ]);
    expect(
      outcome.brief.keyframes[0].path.startsWith('active/shared/tmp/video-ingest-tests/')
    ).toBe(true);
  });

  it('falls back to deduped automatic captions when no manual subtitles exist', async () => {
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: fakeRunner({ automatic_captions: { en: AUTO_VTT } }, calls) })
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.brief.transcript?.origin).toBe('auto_subs');
    expect(outcome.brief.transcript?.segments.map((segment) => segment.text)).toEqual([
      'auto one',
      'auto two',
    ]);
    expect(calls.some((call) => call.args.includes('--write-auto-subs'))).toBe(true);
  });

  it('uses timestamped STT on extracted 16 kHz mono audio when no subtitles exist', async () => {
    const calls: Call[] = [];
    const transcribe = vi.fn(async () => ({
      language: 'en',
      segments: [{ start_sec: 0, end_sec: 1.5, text: 'spoken words' }],
    }));
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: fakeRunner({}, calls), transcribe })
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.brief.transcript).toEqual({
      origin: 'stt',
      language: 'en',
      segments: [{ start_sec: 0, end_sec: 1.5, text: 'spoken words' }],
    });
    const audioCall = calls.find((call) => call.args.includes('pcm_s16le'));
    expect(audioCall?.args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000']));
    expect(outcome.brief.audio_path?.endsWith('/audio.wav')).toBe(true);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('buildVideoBrief cache', () => {
  it('serves a second request from cache without calling the runner', async () => {
    const placement = freshPlacement();
    const first = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        cachePlacement: placement,
        runner: fakeRunner({ subtitles: { en: MANUAL_VTT } }, []),
      })
    );
    expect(first.status).toBe('ok');
    const runner = vi.fn<VideoCommandRunner>();
    const approval = vi.fn();
    const second = await buildVideoBrief(
      { kind: 'url', url: 'https://www.youtube.com/watch?utm_medium=x&v=abc123' },
      options({ cachePlacement: placement, runner, requestApproval: approval, approval: undefined })
    );
    expect(runner).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
    expect(second.status).toBe('ok');
    if (second.status !== 'ok' || first.status !== 'ok') return;
    expect(second.brief.cache_hit).toBe(true);
    expect(second.brief.content_key).toBe(first.brief.content_key);
    expect(first.brief.content_key).toBe(urlContentKey(URL_, POLICY.download_format));
  });
});

describe('buildVideoBrief governance', () => {
  it('returns APPROVAL_REQUIRED for an uncached remote fetch without approval context', async () => {
    const runner = vi.fn<VideoCommandRunner>();
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner, approval: undefined })
    );
    expect(outcome).toMatchObject({ status: 'approval_required', code: 'APPROVAL_REQUIRED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('surfaces a pending approval request id and does not fetch', async () => {
    const runner = vi.fn<VideoCommandRunner>();
    const requestApproval = vi.fn((_request: RiskyApprovalRequest) => ({
      allowed: false,
      status: 'pending' as const,
      requestId: 'APR-1',
    }));
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner, requestApproval })
    );
    expect(outcome).toMatchObject({ code: 'APPROVAL_REQUIRED', request_id: 'APR-1' });
    expect(requestApproval.mock.calls[0][0]).toMatchObject({ opId: 'vision:fetch_video' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses hosts outside allowed_hosts and egress denials', async () => {
    const runner = vi.fn<VideoCommandRunner>();
    const offList = await buildVideoBrief(
      { kind: 'url', url: 'https://example.com/v.mp4' },
      options({ runner })
    );
    expect(offList).toMatchObject({ status: 'failed', code: 'HOST_NOT_ALLOWED' });
    const denied = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        runner,
        evaluateEgress: () => ({ ...allowEgress(), verdict: 'deny', reason: 'blocked' }),
      })
    );
    expect(denied).toMatchObject({ status: 'failed', code: 'EGRESS_DENIED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('enforces max_duration_sec before downloading', async () => {
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: fakeRunner({ duration: 7200 }, calls) })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'DURATION_EXCEEDED' });
    expect(calls).toHaveLength(1);
  });

  it('enforces max_bytes on local files before hashing or probing', async () => {
    const file = path.join(TEST_ROOT, 'big.mp4');
    safeWriteFile(file, 'x'.repeat(64));
    const runner = vi.fn<VideoCommandRunner>();
    const outcome = await buildVideoBrief(
      { kind: 'file', path: file },
      options({ runner, policy: { ...POLICY, max_bytes: 16 } })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'SIZE_EXCEEDED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('classifies stale-extractor failures as EXTRACTOR_OUTDATED without self-updating', async () => {
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        runner: fakeRunner(
          { infoFailure: 'ERROR: [youtube] abc123: Unable to extract nsig' },
          calls
        ),
      })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'EXTRACTOR_OUTDATED' });
    if (outcome.status === 'failed') {
      expect(outcome.remediation).toContain('pnpm tool:setup -- --tool yt_dlp --apply');
    }
    expect(calls.flatMap((call) => call.args)).not.toContain('-U');
    expect(calls.flatMap((call) => call.args)).not.toContain('--update');
    expect(classifyYtDlpFailure('ERROR: Unsupported URL: x')).toBe('EXTRACTOR_OUTDATED');
    expect(classifyYtDlpFailure('HTTP Error 403: Forbidden')).toBe('EXTRACTOR_OUTDATED');
    expect(classifyYtDlpFailure('ERROR: network unreachable')).toBe('TOOL_FAILED');
  });
});

describe('video cache tier placement', () => {
  it('derives tiers from repository paths', () => {
    const root = pathResolver.rootDir();
    expect(tierOfPath(path.join(root, 'knowledge/confidential/acme/v.mp4'))).toBe('confidential');
    expect(tierOfPath(path.join(root, 'active/projects/personal/x/v.mp4'))).toBe('personal');
    expect(tierOfPath(path.join(root, 'active/shared/tmp/v.mp4'))).toBe('public');
    expect(resolveVideoCachePlacement({ tenant_slug: 'acme' })).toMatchObject({
      scope: 'tenant',
      tier: 'confidential',
    });
    expect(resolveVideoCachePlacement()).toMatchObject({ scope: 'shared', tier: 'public' });
    expect(resolveVideoCachePlacement().root.split(path.sep).join('/')).toMatch(
      /active\/shared\/cache\/video-ingest$/
    );
  });

  it('refuses to cache tenant input in the shared cache', async () => {
    const file = path.join(TEST_ROOT, 'tenant-clip.mp4');
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(file, 'clip');
    const runner = vi.fn<VideoCommandRunner>();
    const outcome = await buildVideoBrief(
      { kind: 'file', path: file },
      options({ runner, input_tier: 'confidential' })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'TIER_DOWNGRADE' });
    expect(runner).not.toHaveBeenCalled();
    expect(() =>
      assertNoTierDowngrade('personal', { scope: 'tenant', root: '/x', tier: 'confidential' })
    ).toThrow(/TIER_DOWNGRADE/);
    expect(() =>
      assertNoTierDowngrade('confidential', { scope: 'tenant', root: '/x', tier: 'confidential' })
    ).not.toThrow();
  });

  it('builds a brief for a local public file via ffprobe', async () => {
    const file = path.join(TEST_ROOT, 'public-clip.mp4');
    safeWriteFile(file, 'clip-bytes');
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'file', path: file },
      options({
        runner: fakeRunner({}, calls),
        approval: undefined,
        transcript_preference: 'subtitles_only',
      })
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.brief.metadata).toEqual({ title: 'Local clip', duration_sec: 12.5 });
    expect(outcome.brief.transcript).toBeNull();
    expect(calls.some((call) => call.command === 'fake-yt-dlp')).toBe(false);
  });
});

describe('video media helpers', () => {
  it('plans keyframes chapter > scene > interval with gap and cap', () => {
    expect(
      planKeyframes({
        duration_sec: 100,
        chapters: [{ start_sec: 10, end_sec: 100, title: 'A' }],
        scene_times: [11, 50],
        interval_sec: 40,
        max_keyframes: 3,
      })
    ).toEqual(
      [
        { t_sec: 10, reason: 'chapter' },
        { t_sec: 50, reason: 'scene' },
        { t_sec: 0, reason: 'interval' },
      ].sort((a, b) => a.t_sec - b.t_sec)
    );
  });

  it('parses showinfo pts_time markers', () => {
    expect(parseSceneTimes('x pts_time:1.25 y\nnoise\nz pts_time:7 w')).toEqual([1.25, 7]);
  });
});

describe('governed registrations', () => {
  it('loads the shipped policy with remote approval on by default', () => {
    const policy = loadVideoIngestPolicy();
    expect(policy.require_approval_for_remote).toBe(true);
    expect(policy.allowed_hosts.length).toBeGreaterThan(0);
  });

  it('resolves yt-dlp through KYBERION_YTDLP_BIN, then the registry', () => {
    vi.stubEnv('KYBERION_YTDLP_BIN', '/opt/kyberion/bin/yt-dlp-custom');
    expect(resolveYtDlpBin()).toBe('/opt/kyberion/bin/yt-dlp-custom');
    vi.stubEnv('KYBERION_YTDLP_BIN', '');
    expect(resolveYtDlpBin()).toMatch(/yt-dlp$/);
  });
});
