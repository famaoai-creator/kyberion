import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWorkItem } from './workforce/work-coordination.js';
import { minutesWorkItemId, startInRoomMinutesSession } from './in-room-minutes-recorder.js';
import {
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
} from './voice/speech-to-text-bridge.js';
import { missionDir, missionEvidenceDir, rootResolve } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const missionId = 'MSN-INROOM-MINUTES-001';
const missionPath = missionDir(missionId, 'public');
const workItemRoot = rootResolve('active/shared/tmp/in-room-minutes-test/coordination');
/** Tenant + an isolated coordination store, so tests never touch the real WorkItem ledger. */
const base = () => ({ missionId, tenantSlug: 'test-tenant', workItemRootDir: workItemRoot });

/** ~0.4s of loud speech-like PCM, then ≥0.8s of silence → one VAD endpoint. */
function fixtureCommand(): string[] {
  return [
    process.execPath,
    '-e',
    [
      'const speech=Buffer.alloc(12800);',
      'for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(((i%64)-32)*900,i);',
      'const silence=Buffer.alloc(32000);',
      'process.stdout.write(Buffer.concat([speech,silence]));',
    ].join(''),
  ];
}

beforeEach(() => {
  safeMkdir(workItemRoot, { recursive: true });
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_SUDO = 'true'; // bypass consent in unit tests (gate tested separately)
  safeMkdir(missionPath, { recursive: true });
  safeMkdir(missionEvidenceDir(missionId), { recursive: true });
  registerSpeechToTextBridge({
    name: 'test-fixed',
    // Canned in-process transcription never uploads the captured audio.
    capabilities: { timestamps: false, granularity: 'none', local_only: true },
    transcribe: async () => ({ text: '本日の決定事項は予算承認です', backend: 'test-fixed' }),
  });
});

afterEach(() => {
  safeRmSync(rootResolve('active/shared/tmp/in-room-minutes-test'), {
    recursive: true,
    force: true,
  });
  delete process.env.KYBERION_SUDO;
  resetSpeechToTextBridge();
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('in-room minutes recorder', () => {
  it('captures mic audio into VAD segments, transcribes, and runs the minutes pipeline on stop', async () => {
    const transcripts: string[] = [];
    let pipelineRuns = 0;

    const session = await startInRoomMinutesSession({
      ...base(),
      meetingTitle: '定例会議',
      mic: { command: fixtureCommand(), sampleRateHz: 16000, chunkMs: 100 },
      onTranscriptChunk: (chunk) => transcripts.push(chunk.text),
      runMinutesPipeline: async (input) => {
        pipelineRuns += 1;
        const minutesPath = path.join(missionEvidenceDir(input.missionId), 'minutes.md');
        safeWriteFile(minutesPath, '# 議事録\n- 予算承認\n');
        return { minutesPath };
      },
    });

    await session.done;
    const result = await session.stop();

    expect(result.segments).toBeGreaterThanOrEqual(1);
    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    expect(transcripts[0]).toContain('予算承認');
    expect(pipelineRuns).toBe(1);
    expect(result.minutesPath).toBeTruthy();
    expect(safeExistsSync(result.minutesPath as string)).toBe(true);

    const transcript = safeReadFile(result.transcriptPath, { encoding: 'utf8' }) as string;
    expect(transcript).toContain('本日の決定事項は予算承認です');
    expect(safeExistsSync(path.join(missionEvidenceDir(missionId), 'audio'))).toBe(true);
  });

  it('passes a WorkItem id to the minutes pipeline so mission-scoped reasoning is allowed', async () => {
    let received: { workItemId: string } | undefined;
    const session = await startInRoomMinutesSession({
      ...base(),
      workItemId: 'WI-GIVEN-001',
      mic: { command: fixtureCommand(), sampleRateHz: 16000, chunkMs: 100 },
      runMinutesPipeline: async (input) => {
        received = input;
        return { minutesPath: path.join(missionEvidenceDir(input.missionId), 'minutes.md') };
      },
    });
    await session.done;
    await session.stop();
    expect(received?.workItemId).toBe('WI-GIVEN-001');
  });

  it('creates the minutes WorkItem before capture, scoped to the tenant and mission', async () => {
    let received: { workItemId: string } | undefined;
    const session = await startInRoomMinutesSession({
      ...base(),
      mic: { command: fixtureCommand(), sampleRateHz: 16000, chunkMs: 100 },
      runMinutesPipeline: async (input) => {
        received = input;
        return { minutesPath: '' };
      },
    });
    // Created at session start, i.e. before any audio is processed.
    const item = getWorkItem(minutesWorkItemId(missionId), { rootDir: workItemRoot });
    expect(item?.context).toMatchObject({
      tenant_slug: 'test-tenant',
      mission_id: missionId,
    });
    await session.done;
    await session.stop();
    expect(received?.workItemId).toBe(minutesWorkItemId(missionId));
  });

  it('fails before recording when no tenant is known for the WorkItem', async () => {
    const saved = process.env.KYBERION_TENANT;
    delete process.env.KYBERION_TENANT;
    try {
      await expect(
        startInRoomMinutesSession({
          missionId,
          workItemRootDir: workItemRoot,
          mic: { command: fixtureCommand(), sampleRateHz: 16000 },
        })
      ).rejects.toThrow('tenant required');
    } finally {
      if (saved !== undefined) process.env.KYBERION_TENANT = saved;
    }
  });

  it('fails before recording when the WorkItem exists under another tenant', async () => {
    await startInRoomMinutesSession({
      ...base(),
      mic: { command: [process.execPath, '-e', ''], sampleRateHz: 16000 },
      runMinutesPipeline: async () => ({ minutesPath: '' }),
    }).then((s) => s.stop());
    await expect(
      startInRoomMinutesSession({
        ...base(),
        tenantSlug: 'other-tenant',
        mic: { command: fixtureCommand(), sampleRateHz: 16000 },
      })
    ).rejects.toThrow('cannot prepare the minutes WorkItem');
  });

  it('derives a stable minutes WorkItem id from the mission id', () => {
    expect(minutesWorkItemId('msn-acme-board-20261020')).toBe('WI-ACME-BOARD-20261020-MINUTES');
  });

  it('warns once when only silence is captured', async () => {
    const warnings: number[] = [];
    const session = await startInRoomMinutesSession({
      ...base(),
      mic: {
        command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(64000))'],
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      silenceWarnSeconds: 1,
      onSilenceWarning: ({ seconds }) => warnings.push(seconds),
      runMinutesPipeline: async () => ({ minutesPath: '' }),
    });
    await session.done;
    await session.stop();
    expect(warnings).toHaveLength(1);
  });

  it('re-arms after speech, so a source that goes dead mid-meeting warns', async () => {
    const warnings: number[] = [];
    // 0.4s of speech, then 2s of exact silence.
    const cmd = [
      process.execPath,
      '-e',
      [
        'const s=Buffer.alloc(12800);',
        'for(let i=0;i<s.length;i+=2)s.writeInt16LE(((i%64)-32)*900,i);',
        'process.stdout.write(Buffer.concat([s,Buffer.alloc(64000)]));',
      ].join(''),
    ];
    const session = await startInRoomMinutesSession({
      ...base(),
      mic: { command: cmd, sampleRateHz: 16000, chunkMs: 100 },
      silenceWarnSeconds: 1,
      onSilenceWarning: ({ seconds }) => warnings.push(seconds),
      runMinutesPipeline: async () => ({ minutesPath: '' }),
    });
    await session.done;
    await session.stop();
    expect(warnings).toHaveLength(1);
  });

  it('keeps recording when the silence observer throws', async () => {
    const session = await startInRoomMinutesSession({
      ...base(),
      mic: {
        command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(64000))'],
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      silenceWarnSeconds: 1,
      onSilenceWarning: () => {
        throw new Error('observer failed');
      },
      runMinutesPipeline: async () => ({ minutesPath: '' }),
    });
    await expect(session.done).resolves.toBeUndefined();
    await session.stop();
  });

  it('does not warn for a short pause after speech (shorter than the window)', async () => {
    const warnings: number[] = [];
    const session = await startInRoomMinutesSession({
      ...base(),
      mic: { command: fixtureCommand(), sampleRateHz: 16000, chunkMs: 100 },
      silenceWarnSeconds: 5,
      onSilenceWarning: ({ seconds }) => warnings.push(seconds),
      runMinutesPipeline: async () => ({ minutesPath: '' }),
    });
    await session.done;
    await session.stop();
    expect(warnings).toHaveLength(0);
  });

  it('fails closed when recording consent is missing', async () => {
    delete process.env.KYBERION_SUDO;
    await expect(
      startInRoomMinutesSession({
        missionId,
        mic: { command: fixtureCommand(), sampleRateHz: 16000 },
      })
    ).rejects.toThrow(/recording consent/);
  });

  it('rejects a transcript path replaced by a directory before starting capture', async () => {
    const transcriptPath = path.join(missionEvidenceDir(missionId), 'transcript.md');
    safeMkdir(transcriptPath, { recursive: true });

    try {
      await expect(
        startInRoomMinutesSession({
          ...base(),
          mic: { command: fixtureCommand(), sampleRateHz: 16000 },
        })
      ).rejects.toThrow('[IN_ROOM_MINUTES_RESOURCE] transcript must be a regular file');
    } finally {
      safeRmSync(transcriptPath, { recursive: true, force: true });
    }
  });
});
