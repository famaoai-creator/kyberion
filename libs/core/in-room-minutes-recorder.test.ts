import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startInRoomMinutesSession } from './in-room-minutes-recorder.js';
import { registerSpeechToTextBridge } from './speech-to-text-bridge.js';
import { missionDir, missionEvidenceDir } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const missionId = 'MSN-INROOM-MINUTES-001';
const missionPath = missionDir(missionId, 'public');

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
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_SUDO = 'true'; // bypass consent in unit tests (gate tested separately)
  safeMkdir(missionEvidenceDir(missionId), { recursive: true });
  registerSpeechToTextBridge({
    name: 'test-fixed',
    transcribe: async () => ({ text: '本日の決定事項は予算承認です', backend: 'test-fixed' }),
  });
});

afterEach(() => {
  delete process.env.KYBERION_SUDO;
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('in-room minutes recorder', () => {
  it('captures mic audio into VAD segments, transcribes, and runs the minutes pipeline on stop', async () => {
    const transcripts: string[] = [];
    let pipelineRuns = 0;

    const session = await startInRoomMinutesSession({
      missionId,
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

  it('fails closed when recording consent is missing', async () => {
    delete process.env.KYBERION_SUDO;
    await expect(
      startInRoomMinutesSession({
        missionId,
        mic: { command: fixtureCommand(), sampleRateHz: 16000 },
      })
    ).rejects.toThrow(/recording consent/);
  });
});
