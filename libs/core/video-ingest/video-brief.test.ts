import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { resolveYtDlpBin } from '../tool-binary-resolvers.js';
import type { EgressPolicyDecision } from '../egress-policy.js';
import type { RiskyApprovalRequest, RiskyApprovalResult } from '../risky-op-approval-port.js';
import {
  assertNoTierDowngrade,
  buildVideoBrief as publicBuildVideoBrief,
  buildVideoBriefWithInternals,
  resolveVideoCachePlacement,
  tenantOfPath,
  tierOfPath,
  videoEntryLockResource,
  videoFetchCorrelationId,
  type BuildVideoBriefOptions,
  type VideoBriefInternals,
  type VideoCachePlacement,
} from './video-brief.js';
import {
  classifyYtDlpFailure,
  fileContentKey,
  loadVideoIngestPolicy,
  sha256FileChunked,
  sha256Hex,
  urlContentKey,
} from './video-fetch.js';
import { parseSceneTimes, planKeyframes } from './video-media.js';
import type {
  VideoCommandResult,
  VideoCommandRunner,
  VideoIngestPolicy,
  VideoSource,
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
  duration?: number | null;
  is_live?: boolean;
  requested_formats?: Array<{ filesize?: number }>;
  subtitles?: Record<string, string>;
  automatic_captions?: Record<string, string>;
  infoFailure?: string;
  /** Files yt-dlp leaves in the -P directory (default: source.mp4). */
  downloadFiles?: Record<string, string>;
  downloadFailure?: string;
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
          ...(video.duration === null ? {} : { duration: video.duration ?? 90 }),
          ...(video.is_live ? { is_live: true, live_status: 'is_live' } : {}),
          ...(video.requested_formats ? { requested_formats: video.requested_formats } : {}),
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
      const dir = args[args.indexOf('-P') + 1];
      for (const [name, body] of Object.entries(video.downloadFiles ?? { 'source.mp4': 'media' })) {
        safeWriteFile(path.join(dir, name), body);
      }
      if (video.downloadFailure) return { stdout: '', stderr: video.downloadFailure, status: 1 };
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

type TestOptions = BuildVideoBriefOptions & VideoBriefInternals;

const INTERNAL_KEYS: ReadonlySet<string> = new Set<keyof VideoBriefInternals>([
  'runner',
  'policy',
  'cachePlacement',
  'authorizeTenant',
  'transcribe',
  'evaluateEgress',
  'requestApproval',
  'now',
  'bins',
]);

/** Routes test seams to the internals argument and the rest to the public options. */
function buildVideoBrief(source: VideoSource, all: TestOptions = {}) {
  const publicOptions: Record<string, unknown> = {};
  const internals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) {
    (INTERNAL_KEYS.has(key) ? internals : publicOptions)[key] = value;
  }
  return buildVideoBriefWithInternals(
    source,
    publicOptions as BuildVideoBriefOptions,
    internals as VideoBriefInternals
  );
}

function options(overrides: Partial<TestOptions> = {}): TestOptions {
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

/** Tenant authorizer that accepts every slug (the registry is not a fixture here). */
const registered = () => undefined;

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
    expect(resolveVideoCachePlacement({ tenant_slug: 'acme' }, registered)).toMatchObject({
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

const URL_B = 'https://www.youtube.com/watch?v=other999';

function entryDirOf(placement: VideoCachePlacement, url: string): string {
  return path.join(placement.root, urlContentKey(url, POLICY.download_format));
}

/** Correlation id the brief derives for a normalized URL under a policy. */
function correlationFor(url: string, policy: VideoIngestPolicy = POLICY): string {
  return videoFetchCorrelationId(urlContentKey(url, policy.download_format), {
    url,
    format: policy.download_format,
    max_bytes: policy.max_bytes,
    max_duration_sec: policy.max_duration_sec,
  });
}

describe('remote fetch approval binding', () => {
  it('derives the correlation id per fetch so an approval for URL A cannot authorize URL B', async () => {
    const approved = new Set<string>();
    const requests: RiskyApprovalRequest[] = [];
    const requestApproval = (request: RiskyApprovalRequest): RiskyApprovalResult => {
      requests.push(request);
      return approved.has(request.correlationId ?? '')
        ? { allowed: true, status: 'approved', requestId: 'APR-A' }
        : { allowed: false, status: 'pending', requestId: `APR-${requests.length}` };
    };
    const first = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: vi.fn<VideoCommandRunner>(), requestApproval })
    );
    expect(first.status).toBe('approval_required');
    const corrA = correlationFor('https://www.youtube.com/watch?v=abc123');
    expect(requests[0]).toMatchObject({
      opId: 'vision:fetch_video',
      correlationId: corrA,
      channel: 'system',
      payload: {
        url: 'https://www.youtube.com/watch?v=abc123',
        format: POLICY.download_format,
        max_bytes: POLICY.max_bytes,
        max_duration_sec: POLICY.max_duration_sec,
      },
    });
    approved.add(corrA);

    // Caller-supplied correlation/presence fields are ignored.
    const runner = vi.fn<VideoCommandRunner>();
    const replay = await buildVideoBrief(
      { kind: 'url', url: URL_B },
      options({
        runner,
        requestApproval,
        approval: {
          agent_id: 'test-agent',
          correlation_id: corrA,
          channel: 'slack',
          has_human: true,
        } as unknown as BuildVideoBriefOptions['approval'],
      })
    );
    expect(replay).toMatchObject({ status: 'approval_required' });
    expect(runner).not.toHaveBeenCalled();
    const last = requests[requests.length - 1];
    expect(last.correlationId).toBe(correlationFor(URL_B));
    expect(last.channel).toBe('system');
    expect(last).not.toHaveProperty('hasHuman');
  });
});

describe('remote fetch approval lifetime', () => {
  function capture() {
    const requests: RiskyApprovalRequest[] = [];
    const requestApproval = (request: RiskyApprovalRequest): RiskyApprovalResult => {
      requests.push(request);
      return { allowed: false, status: 'pending', requestId: `APR-${requests.length}` };
    };
    return { requests, requestApproval };
  }

  it('asks again under a new correlation when the policy limits change', async () => {
    const { requests, requestApproval } = capture();
    await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: vi.fn<VideoCommandRunner>(), requestApproval })
    );
    const raised = { ...POLICY, max_bytes: POLICY.max_bytes * 2 };
    await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: vi.fn<VideoCommandRunner>(), requestApproval, policy: raised })
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].correlationId).not.toBe(requests[1].correlationId);
    expect(requests[1].correlationId).toBe(
      correlationFor('https://www.youtube.com/watch?v=abc123', raised)
    );
  });

  it('stamps a 24h expiry so a rejected or stale request does not lock the URL', async () => {
    const { requests, requestApproval } = capture();
    const now = Date.parse('2026-09-26T00:00:00.000Z');
    await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: vi.fn<VideoCommandRunner>(), requestApproval, now: () => now })
    );
    expect(requests[0].expiresAt).toBe('2026-09-27T00:00:00.000Z');
  });
});

describe('remote fetch safety', () => {
  it('refuses live streams and unknown durations before downloading', async () => {
    for (const [video, code] of [
      [{ is_live: true }, 'LIVE_STREAM'],
      [{ duration: null }, 'DURATION_UNKNOWN'],
    ] as const) {
      const calls: Call[] = [];
      const outcome = await buildVideoBrief(
        { kind: 'url', url: URL_ },
        options({ runner: fakeRunner(video, calls) })
      );
      expect(outcome).toMatchObject({ status: 'failed', code });
      expect(calls).toHaveLength(1);
    }
  });

  it('probes with the download format and sums requested_formats for the size check', async () => {
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        runner: fakeRunner(
          { requested_formats: [{ filesize: POLICY.max_bytes }, { filesize: 10 }] },
          calls
        ),
      })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'SIZE_EXCEEDED' });
    const probe = calls[0].args;
    expect(probe[probe.indexOf('-f') + 1]).toBe(POLICY.download_format);
    expect(probe.indexOf('-f')).toBeLessThan(probe.indexOf('-J'));
  });

  it('downloads via -P with a relative template, ffmpeg location and a live filter', async () => {
    const calls: Call[] = [];
    const placement = freshPlacement();
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ cachePlacement: placement, runner: fakeRunner({}, calls) })
    );
    expect(outcome.status).toBe('ok');
    const download = calls.find(
      (call) => call.command === 'fake-yt-dlp' && !call.args.includes('-J')
    );
    const args = download?.args ?? [];
    expect(args[args.indexOf('-P') + 1]).toBe(entryDirOf(placement, URL_));
    expect(args[args.indexOf('-o') + 1]).toBe('source.%(ext)s');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('fake-ffmpeg');
    expect(args[args.indexOf('--match-filter') + 1]).toBe('!is_live');
  });

  it('picks the merged output over leftover split streams', async () => {
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        runner: fakeRunner(
          {
            downloadFiles: {
              'source.f137.mp4': 'video-only',
              'source.f140.m4a': 'audio-only',
              'source.mp4': 'merged',
            },
          },
          calls
        ),
      })
    );
    expect(outcome.status).toBe('ok');
    const thumbnail = calls.find(
      (call) =>
        call.args.includes('thumbnail.jpg') ||
        call.args.some((arg) => arg.endsWith('thumbnail.jpg'))
    );
    expect(thumbnail?.args[thumbnail.args.indexOf('-i') + 1].endsWith('source.mp4')).toBe(true);
  });

  it('refuses when only split streams exist and removes them', async () => {
    const placement = freshPlacement();
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        cachePlacement: placement,
        runner: fakeRunner(
          { downloadFiles: { 'source.f137.mp4': 'v', 'source.f140.m4a': 'a' } },
          []
        ),
      })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'TOOL_FAILED' });
    if (outcome.status === 'failed') expect(outcome.message).toContain('split');
    expect(safeReaddir(entryDirOf(placement, URL_)).filter((n) => n.startsWith('source.'))).toEqual(
      []
    );
  });
});

describe('video cache retention', () => {
  it('removes oversize or partial media from the cache entry on a failed download', async () => {
    const placement = freshPlacement();
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        cachePlacement: placement,
        policy: { ...POLICY, max_bytes: 16 },
        runner: fakeRunner(
          { downloadFiles: { 'source.mp4': 'x'.repeat(64), 'source.f1.mp4.part': 'p' } },
          []
        ),
      })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'SIZE_EXCEEDED' });
    const entry = path.join(placement.root, urlContentKey(URL_, POLICY.download_format));
    expect(safeReaddir(entry)).toEqual([]);
  });

  it('deletes downloaded source media after derivation unless keep_source', async () => {
    const placement = freshPlacement();
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        cachePlacement: placement,
        runner: fakeRunner({ subtitles: { en: MANUAL_VTT } }, []),
      })
    );
    expect(outcome.status).toBe('ok');
    const entry = entryDirOf(placement, URL_);
    const names = safeReaddir(entry);
    expect(names).not.toContain('source.mp4');
    expect(names).toContain('source.en.vtt');
    expect(names.some((name) => name.startsWith('brief-'))).toBe(true);

    const kept = freshPlacement();
    await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ cachePlacement: kept, keep_source: true, runner: fakeRunner({}, []) })
    );
    expect(safeExistsSync(path.join(entryDirOf(kept, URL_), 'source.mp4'))).toBe(true);
  });

  it('serializes runs on one cache entry so a second run cannot delete media mid-derivation', async () => {
    const placement = freshPlacement();
    let releaseFirst: () => void = () => undefined;
    const firstDerivation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let downloads = 0;
    let mediaSeenByFfmpeg = true;
    const base = fakeRunner({ subtitles: { en: MANUAL_VTT } }, []);
    const runner: VideoCommandRunner = async (command, args, opts) => {
      if (command === 'fake-yt-dlp' && !args.includes('-J')) downloads += 1;
      if (command === 'fake-ffmpeg' && args.includes('-ss')) {
        await firstDerivation;
        const input = args[args.indexOf('-i') + 1];
        if (!safeExistsSync(input)) mediaSeenByFfmpeg = false;
      }
      return base(command, args, opts);
    };
    const first = buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ cachePlacement: placement, runner })
    );
    const second = buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ cachePlacement: placement, runner })
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('ok');
    expect(b).toMatchObject({ status: 'ok', brief: { cache_hit: true } });
    expect(downloads).toBe(1);
    expect(mediaSeenByFfmpeg).toBe(true);
  });

  it('reuses kept source media instead of deleting it on a failed re-download', async () => {
    const placement = freshPlacement();
    const entry = entryDirOf(placement, URL_);
    safeMkdir(entry, { recursive: true });
    safeWriteFile(path.join(entry, 'source.mp4'), 'kept-media');
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({
        cachePlacement: placement,
        runner: fakeRunner({ downloadFailure: 'HTTP Error 403: Forbidden' }, calls),
      })
    );
    expect(outcome.status).toBe('ok');
    expect(calls.some((call) => call.command === 'fake-yt-dlp' && !call.args.includes('-J'))).toBe(
      false
    );
    expect(safeExistsSync(path.join(entry, 'source.mp4'))).toBe(true);
  });

  it('never deletes a local input file', async () => {
    const file = path.join(TEST_ROOT, 'keep-local.mp4');
    safeWriteFile(file, 'local-bytes');
    const outcome = await buildVideoBrief(
      { kind: 'file', path: file },
      options({ runner: fakeRunner({}, []), transcript_preference: 'subtitles_only' })
    );
    expect(outcome.status).toBe('ok');
    expect(safeExistsSync(file)).toBe(true);
  });
});

describe('local content key hashing', () => {
  it('hashes in bounded chunks and matches a whole-buffer digest', () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) % 251;
    const lengths: number[] = [];
    const digest = sha256FileChunked(
      'fixture.mp4',
      data.length,
      (_file, position, length) => {
        lengths.push(length);
        return data.subarray(position, position + length);
      },
      1024 * 1024
    );
    expect(digest).toBe(sha256Hex(data));
    expect(lengths).toEqual([1024 * 1024, 1024 * 1024, 1024 * 1024, 17]);
  });

  it('fileContentKey reads through the injected range reader', () => {
    const file = path.join(TEST_ROOT, 'chunked.mp4');
    const body = 'y'.repeat(4096);
    safeWriteFile(file, body);
    const reads: number[] = [];
    const key = fileContentKey(file, 1024 * 1024, (_file, position, length) => {
      reads.push(length);
      return Buffer.from(body).subarray(position, position + length);
    });
    expect(key).toBe(sha256Hex(body));
    expect(reads.length).toBeGreaterThan(0);
  });
});

describe('manual subtitles through the brief', () => {
  it('keeps genuine repeated lines from manual subtitles', async () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'Go!',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Go!',
      '',
    ].join('\n');
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ runner: fakeRunner({ subtitles: { en: vtt } }, []) })
    );
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.brief.transcript?.segments.map((segment) => segment.text)).toEqual([
      'Go!',
      'Go!',
    ]);
  });
});

describe('video cache tenant placement', () => {
  const root = pathResolver.rootDir();
  // Tenant/mission fixtures live in governed confidential partitions.
  const asMissionController = () => vi.stubEnv('MISSION_ROLE', 'mission_controller');

  it('derives the owning tenant from repository paths', () => {
    expect(tenantOfPath(path.join(root, 'knowledge/confidential/acme/v.mp4'))).toBe('acme');
    expect(tenantOfPath(path.join(root, 'knowledge/confidential/common/v.mp4'))).toBeUndefined();
    expect(tenantOfPath(path.join(root, 'active/projects/confidential/acme/x/v.mp4'))).toBe('acme');
    expect(
      tenantOfPath(path.join(root, 'active/missions/confidential/acme/MSN-X-1/evidence/v.mp4'))
    ).toBe('acme');
    expect(tenantOfPath(path.join(root, 'active/shared/tmp/v.mp4'))).toBeUndefined();
    expect(resolveVideoCachePlacement({ tenant_slug: 'acme' }, registered).tenant_slug).toBe(
      'acme'
    );
  });

  it("resolves a mission directory's tenant from its mission state", () => {
    const missionId = `MSN-VIDEO-TENANT-${randomUUID().slice(0, 8).toUpperCase()}`;
    const missionDir = path.join(root, 'active/missions/confidential', missionId);
    asMissionController();
    try {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({ mission_id: missionId, tenant_slug: 'globex' })
      );
      expect(tenantOfPath(path.join(missionDir, 'evidence/v.mp4'))).toBe('globex');
    } finally {
      safeRmSync(missionDir, { recursive: true, force: true });
    }
  });

  it("refuses to cache tenant A's input under tenant B", async () => {
    const slug = `vt${randomUUID().slice(0, 8)}`;
    const tenantDir = path.join(root, 'active/projects/confidential', slug);
    const file = path.join(tenantDir, 'clip.mp4');
    asMissionController();
    try {
      safeMkdir(tenantDir, { recursive: true });
      safeWriteFile(file, 'tenant-a-clip');
      const runner = vi.fn<VideoCommandRunner>();
      const other: VideoCachePlacement = {
        scope: 'tenant',
        root: path.join(TEST_ROOT, randomUUID()),
        tier: 'confidential',
        tenant_slug: 'other-tenant',
      };
      const mismatch = await buildVideoBrief(
        { kind: 'file', path: file },
        options({ runner, cachePlacement: other })
      );
      expect(mismatch).toMatchObject({ status: 'failed', code: 'TENANT_MISMATCH' });
      const tenantless = await buildVideoBrief(
        { kind: 'file', path: file },
        options({ runner, cachePlacement: { ...other, scope: 'mission', tenant_slug: undefined } })
      );
      expect(tenantless).toMatchObject({ status: 'failed', code: 'TENANT_MISMATCH' });
      expect(runner).not.toHaveBeenCalled();
      const same = await buildVideoBrief(
        { kind: 'file', path: file },
        options({
          runner: fakeRunner({}, []),
          cachePlacement: { ...other, tenant_slug: slug },
          transcript_preference: 'subtitles_only',
        })
      );
      expect(same.status).toBe('ok');
    } finally {
      safeRmSync(tenantDir, { recursive: true, force: true });
    }
  });
});

describe('video cache fail-closed classification', () => {
  const root = pathResolver.rootDir();
  const asMissionController = () => vi.stubEnv('MISSION_ROLE', 'mission_controller');

  it('classifies tier and tenant partitions case-insensitively', () => {
    expect(tierOfPath(path.join(root, 'Knowledge/Confidential/ACME/v.mp4'))).toBe('confidential');
    expect(tierOfPath(path.join(root, 'active/Projects/PERSONAL/acme/v.mp4'))).toBe('personal');
    expect(tenantOfPath(path.join(root, 'knowledge/CONFIDENTIAL/Acme/v.mp4'))).toBe('acme');
    expect(tenantOfPath(path.join(root, 'active/projects/Confidential/ACME/x/v.mp4'))).toBe('acme');
    expect(tenantOfPath(path.join(root, 'knowledge/confidential/Common/v.mp4'))).toBeUndefined();
  });

  it('fails closed when a tenant-scoped partition has no resolvable tenant', () => {
    for (const rel of [
      'knowledge/confidential/v.mp4',
      'knowledge/confidential/Not_A_Slug/v.mp4',
      'knowledge/confidential/confidential/v.mp4',
      'active/projects/confidential/x_y/v.mp4',
      'active/missions/personal/@bad/v.mp4',
    ]) {
      expect(() => tenantOfPath(path.join(root, rel)), rel).toThrow(/TENANT_UNRESOLVED/);
    }
    // Public partitions are not tenant-scoped.
    expect(tenantOfPath(path.join(root, 'active/projects/public/x_y/v.mp4'))).toBeUndefined();
    expect(() => tierOfPath('/definitely/outside/the/repo.mp4')).toThrow(/TIER_UNRESOLVED/);
  });

  it('attributes the tenant-scoped organization tree like projects (B1)', () => {
    expect(
      tenantOfPath(path.join(root, 'active/organizations/confidential/acme/org-1/v.mp4'))
    ).toBe('acme');
    expect(tenantOfPath(path.join(root, 'active/organizations/Personal/ACME/org-1/v.mp4'))).toBe(
      'acme'
    );
    expect(
      tenantOfPath(path.join(root, 'active/organizations/confidential/shared/org-1/v.mp4'))
    ).toBeUndefined();
    expect(
      tenantOfPath(path.join(root, 'active/projects/confidential/shared/p-1/v.mp4'))
    ).toBeUndefined();
    for (const rel of [
      'active/organizations/confidential/x_y/org-1/v.mp4',
      'active/organizations/personal',
      'active/organizations/personal/@bad/v.mp4',
    ]) {
      expect(() => tenantOfPath(path.join(root, rel)), rel).toThrow(/TENANT_UNRESOLVED/);
    }
  });

  it("refuses to cache one tenant's organization media under another tenant", async () => {
    const slug = `vo${randomUUID().slice(0, 8)}`;
    const orgRoot = path.join(root, 'active/organizations/confidential', slug);
    const file = path.join(orgRoot, 'org-1', 'clip.mp4');
    vi.stubEnv('KYBERION_PERSONA', 'sovereign');
    try {
      safeMkdir(path.dirname(file), { recursive: true });
      safeWriteFile(file, 'org-clip');
      const runner = vi.fn<VideoCommandRunner>();
      const outcome = await buildVideoBrief(
        { kind: 'file', path: file },
        options({
          runner,
          cachePlacement: {
            scope: 'tenant',
            root: path.join(TEST_ROOT, randomUUID()),
            tier: 'confidential',
            tenant_slug: 'other-tenant',
          },
        })
      );
      expect(outcome).toMatchObject({ status: 'failed', code: 'TENANT_MISMATCH' });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      safeRmSync(orgRoot, { recursive: true, force: true });
    }
  });

  it('fails closed for any non-public path without a tenant partition', () => {
    for (const rel of ['knowledge/personal/v.mp4', 'active/personal/v.mp4', 'vault/v.mp4']) {
      expect(tierOfPath(path.join(root, rel)), rel).toBe('personal');
      expect(() => tenantOfPath(path.join(root, rel)), rel).toThrow(/TENANT_UNRESOLVED/);
    }
  });

  it('refuses a tenant-partition mission whose state claims another tenant', () => {
    const missionId = `MSN-VIDEO-CLAIM-${randomUUID().slice(0, 8).toUpperCase()}`;
    const partition = `vc${randomUUID().slice(0, 8)}`;
    const partitionDir = path.join(root, 'active/missions/confidential', partition);
    const missionDir = path.join(partitionDir, missionId);
    asMissionController();
    try {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({ mission_id: missionId, tenant_slug: 'globex' })
      );
      expect(() => tenantOfPath(path.join(missionDir, 'evidence/v.mp4'))).toThrow(
        /TENANT_UNRESOLVED/
      );
    } finally {
      safeRmSync(partitionDir, { recursive: true, force: true });
    }
  });

  it('fails closed on a confidential mission whose state names an invalid tenant', () => {
    const missionId = `MSN-VIDEO-BADTENANT-${randomUUID().slice(0, 8).toUpperCase()}`;
    const missionDir = path.join(root, 'active/missions/confidential', missionId);
    asMissionController();
    try {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({ mission_id: missionId, tenant_slug: 'Not A Slug' })
      );
      expect(() => tenantOfPath(path.join(missionDir, 'evidence/v.mp4'))).toThrow(
        /TENANT_UNRESOLVED/
      );
    } finally {
      safeRmSync(missionDir, { recursive: true, force: true });
    }
  });

  it('classifies through a symlinked parent directory and refuses a cross-tenant cache', async () => {
    const slug = `vl${randomUUID().slice(0, 8)}`;
    const tenantDir = path.join(root, 'active/projects/confidential', slug);
    const linkDir = path.join(TEST_ROOT, `link-${randomUUID()}`);
    asMissionController();
    try {
      safeMkdir(tenantDir, { recursive: true });
      safeWriteFile(path.join(tenantDir, 'clip.mp4'), 'tenant-clip');
      safeSymlinkSync(tenantDir, linkDir);
      const viaLink = path.join(linkDir, 'clip.mp4');
      expect(tierOfPath(viaLink)).toBe('confidential');
      expect(tenantOfPath(viaLink)).toBe(slug);
      const runner = vi.fn<VideoCommandRunner>();
      const outcome = await buildVideoBrief(
        { kind: 'file', path: viaLink },
        options({
          runner,
          cachePlacement: {
            scope: 'tenant',
            root: path.join(TEST_ROOT, randomUUID()),
            tier: 'confidential',
            tenant_slug: 'other-tenant',
          },
        })
      );
      expect(outcome).toMatchObject({ status: 'failed', code: 'TENANT_MISMATCH' });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      safeRmSync(linkDir, { force: true });
      safeRmSync(tenantDir, { recursive: true, force: true });
    }
  });
});

describe('video cache mission placement', () => {
  it('rejects a malformed mission id before touching the filesystem', () => {
    for (const id of ['..', '../x', 'a/../../b', '--help']) {
      expect(() => resolveVideoCachePlacement({ mission_id: id }), id).toThrow(/INVALID_SOURCE/);
    }
  });

  it('rejects a mission that does not exist', async () => {
    const missionId = `MSN-VIDEO-NOPE-${randomUUID().slice(0, 8).toUpperCase()}`;
    expect(() => resolveVideoCachePlacement({ mission_id: missionId })).toThrow(
      /INVALID_SOURCE.*does not exist/
    );
    const outcome = await buildVideoBrief(
      { kind: 'url', url: URL_ },
      options({ cachePlacement: undefined, mission_id: missionId, runner: vi.fn() })
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'INVALID_SOURCE' });
  });
});

describe('video cache tenant authorization', () => {
  const root = pathResolver.rootDir();
  const asMissionController = () => vi.stubEnv('MISSION_ROLE', 'mission_controller');

  it('requires a caller-named tenant to resolve in the tenant registry', () => {
    const slug = `vu${randomUUID().slice(0, 8)}`;
    expect(() => resolveVideoCachePlacement({ tenant_slug: slug })).toThrow(/TENANT_UNRESOLVED/);
    const seen: string[] = [];
    expect(
      resolveVideoCachePlacement({ tenant_slug: slug }, (tenant) => {
        seen.push(tenant);
      })
    ).toMatchObject({ scope: 'tenant', tenant_slug: slug });
    expect(seen).toEqual([slug]);
  });

  it("refuses a tenant_slug that is not the mission's own tenant", () => {
    const missionId = `MSN-VIDEO-OWNER-${randomUUID().slice(0, 8).toUpperCase()}`;
    const missionDir = path.join(root, 'active/missions/confidential', missionId);
    asMissionController();
    try {
      safeMkdir(missionDir, { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({ mission_id: missionId, tenant_slug: 'globex' })
      );
      expect(() =>
        resolveVideoCachePlacement({ mission_id: missionId, tenant_slug: 'acme' }, registered)
      ).toThrow(/TENANT_MISMATCH/);
      expect(
        resolveVideoCachePlacement({ mission_id: missionId, tenant_slug: 'globex' }, registered)
      ).toMatchObject({ scope: 'mission', tenant_slug: 'globex' });
    } finally {
      safeRmSync(missionDir, { recursive: true, force: true });
    }
  });
});

describe('local input canonicalization', () => {
  it('refuses a symlinked input file', async () => {
    const dir = path.join(TEST_ROOT, randomUUID());
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'real.mp4'), 'clip');
    const link = path.join(dir, 'link.mp4');
    safeSymlinkSync(path.join(dir, 'real.mp4'), link);
    const runner = vi.fn<VideoCommandRunner>();
    const outcome = await buildVideoBrief({ kind: 'file', path: link }, options({ runner }));
    expect(outcome).toMatchObject({ status: 'failed', code: 'INVALID_SOURCE' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('hands the canonical input path to ffprobe and ffmpeg', async () => {
    const realDir = path.join(TEST_ROOT, randomUUID());
    const linkDir = path.join(TEST_ROOT, `alias-${randomUUID()}`);
    safeMkdir(realDir, { recursive: true });
    safeWriteFile(path.join(realDir, 'clip.mp4'), 'clip-canonical');
    safeSymlinkSync(realDir, linkDir);
    const calls: Call[] = [];
    const outcome = await buildVideoBrief(
      { kind: 'file', path: path.join(linkDir, 'clip.mp4') },
      options({
        runner: fakeRunner({}, calls),
        approval: undefined,
        transcript_preference: 'subtitles_only',
      })
    );
    expect(outcome.status).toBe('ok');
    const inputs = calls.flatMap((call) =>
      call.command === 'fake-ffprobe'
        ? [call.args[call.args.length - 1]]
        : call.args.includes('-i')
          ? [call.args[call.args.indexOf('-i') + 1]]
          : []
    );
    expect(inputs.length).toBeGreaterThan(1);
    for (const input of inputs) {
      expect(input).not.toContain(`alias-`);
      expect(input.endsWith(`${path.basename(realDir)}${path.sep}clip.mp4`)).toBe(true);
    }
  });
});

describe('internal seams are not caller options (S9)', () => {
  it('ignores seams smuggled into the public options', async () => {
    const placement = freshPlacement();
    const contentKey = urlContentKey(
      'https://www.youtube.com/watch?v=abc123',
      POLICY.download_format
    );
    safeMkdir(path.join(placement.root, contentKey), { recursive: true });
    // A planted brief in an attacker-chosen placement must not be served.
    const variant = sha256Hex(
      JSON.stringify({
        language: null,
        max_keyframes: POLICY.default_max_keyframes,
        transcript_preference: 'auto',
      })
    ).slice(0, 12);
    safeWriteFile(
      path.join(placement.root, contentKey, `brief-${variant}.json`),
      JSON.stringify({ content_key: contentKey, planted: true })
    );
    const smuggled = {
      policy: POLICY,
      cachePlacement: placement,
      evaluateEgress: allowEgress,
      requestApproval: () => ({ allowed: true, status: 'approved' }),
    } as unknown as BuildVideoBriefOptions;
    const outcome = await publicBuildVideoBrief({ kind: 'url', url: URL_ }, smuggled);
    expect(outcome.status).not.toBe('ok');
  });
});

describe('cache entry lock key', () => {
  it('shares one lock across case variants on case-insensitive platforms', () => {
    const upper = path.join(TEST_ROOT, 'Entry-ABC');
    const lower = path.join(TEST_ROOT, 'entry-abc');
    expect(videoEntryLockResource(upper, 'darwin')).toBe(videoEntryLockResource(lower, 'darwin'));
    expect(videoEntryLockResource(upper, 'win32')).toBe(videoEntryLockResource(lower, 'win32'));
    expect(videoEntryLockResource(upper, 'linux')).not.toBe(videoEntryLockResource(lower, 'linux'));
  });

  it('keys an entry reached through a symlinked parent by its canonical path', () => {
    const realDir = path.join(TEST_ROOT, randomUUID());
    const linkDir = path.join(TEST_ROOT, `lock-alias-${randomUUID()}`);
    safeMkdir(realDir, { recursive: true });
    safeSymlinkSync(realDir, linkDir);
    expect(videoEntryLockResource(path.join(linkDir, 'k'), 'linux')).toBe(
      videoEntryLockResource(path.join(realDir, 'k'), 'linux')
    );
  });
});
