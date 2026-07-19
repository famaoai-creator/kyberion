import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from './secure-io.js';
import { calibrateRmsThreshold, recordVadTurn } from './vad-turn-recorder.js';

const testDir = pathResolver.sharedTmp('vad-turn-recorder-test');

/** PCM_S16LE mono @16kHz — 32 bytes per millisecond. */
function fixtureCommand(script: string): string[] {
  return [process.execPath, '-e', script];
}

/** 600ms quiet noise → 400ms loud speech → 1000ms silence: one endpoint. */
const CALIBRATE_SPEAK_SILENCE = [
  'const quiet=Buffer.alloc(19200);',
  'for(let i=0;i<quiet.length;i+=2)quiet.writeInt16LE((i%4===0?20:-20),i);',
  'const speech=Buffer.alloc(12800);',
  'for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(((i%64)-32)*900,i);',
  'const silence=Buffer.alloc(32000);',
  'process.stdout.write(Buffer.concat([quiet,speech,silence]));',
].join('');

beforeEach(() => {
  safeMkdir(testDir, { recursive: true });
});

afterEach(() => {
  safeRmSync(testDir, { recursive: true, force: true });
});

describe('calibrateRmsThreshold', () => {
  it('clamps to the floor for silent rooms and to the cap for loud ones', () => {
    expect(calibrateRmsThreshold(0, 3.5)).toBe(250);
    expect(calibrateRmsThreshold(400, 3.5)).toBe(1400);
    expect(calibrateRmsThreshold(1_000_000, 3.5)).toBe(8000);
  });
});

describe('recordVadTurn', () => {
  it('calibrates the noise floor, records one utterance, and stops at the endpoint', async () => {
    const outputPath = path.join(testDir, 'turn-endpoint.wav');
    const states: string[] = [];
    const result = await recordVadTurn({
      outputPath,
      mic: { command: fixtureCommand(CALIBRATE_SPEAK_SILENCE), sampleRateHz: 16000, chunkMs: 100 },
      endpointMs: 700,
      calibrationMs: 500,
      prerollMs: 300,
      onState: (state) => states.push(state),
    });

    expect(result.endpointed).toBe(true);
    expect(result.noiseFloorRms).not.toBeNull();
    expect(result.noiseFloorRms as number).toBeLessThan(100);
    expect(result.rmsThreshold).toBe(250); // quiet room → clamped minimum
    // pre-roll (≤300ms) + 400ms speech + ~700ms endpoint silence, and the
    // 500ms calibration lead-in must NOT be part of the utterance.
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
    expect(result.durationMs).toBeLessThanOrEqual(1600);
    expect(states).toEqual(['calibrating', 'listening', 'recording', 'finalizing']);

    expect(safeExistsSync(outputPath)).toBe(true);
    const wav = safeReadFile(outputPath, { encoding: null }) as Buffer;
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.length).toBe(44 + result.durationMs * 32);
  });

  it('skips calibration when an explicit threshold is provided', async () => {
    const outputPath = path.join(testDir, 'turn-explicit.wav');
    const script = [
      'const speech=Buffer.alloc(12800);',
      'for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(((i%64)-32)*900,i);',
      'process.stdout.write(Buffer.concat([speech,Buffer.alloc(32000)]));',
    ].join('');
    const result = await recordVadTurn({
      outputPath,
      mic: { command: fixtureCommand(script), sampleRateHz: 16000, chunkMs: 100 },
      rmsThreshold: 800,
      endpointMs: 700,
    });

    expect(result.noiseFloorRms).toBeNull();
    expect(result.rmsThreshold).toBe(800);
    expect(result.endpointed).toBe(true);
    expect(safeExistsSync(outputPath)).toBe(true);
  });

  it('flushes at the max utterance cap when speech never pauses', async () => {
    const outputPath = path.join(testDir, 'turn-capped.wav');
    const script = [
      'const speech=Buffer.alloc(64000);',
      'for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(((i%64)-32)*900,i);',
      'process.stdout.write(speech);',
    ].join('');
    const result = await recordVadTurn({
      outputPath,
      mic: { command: fixtureCommand(script), sampleRateHz: 16000, chunkMs: 100 },
      rmsThreshold: 800,
      maxUtteranceSeconds: 1,
    });

    expect(result.endpointed).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
    expect(result.durationMs).toBeLessThanOrEqual(1200);
  });

  it('calibration keeps fan-level noise below the speech threshold (noisy-room fixture)', async () => {
    // Constant noise at RMS ≈ 600 would read as continuous "speech" under
    // the legacy fixed threshold (800 is close); calibration lifts the
    // threshold to noiseFloor × 3.5 so only the real utterance registers.
    const outputPath = path.join(testDir, 'turn-noisy.wav');
    const script = [
      'const mk=(ms,amp)=>{const b=Buffer.alloc(ms*32);for(let i=0;i<b.length;i+=2)b.writeInt16LE(i%4===0?amp:-amp,i);return b};',
      'const noise=(ms)=>mk(ms,600);',
      'const speech=(ms)=>{const b=Buffer.alloc(ms*32);for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*900,i);return b};',
      'process.stdout.write(Buffer.concat([noise(600),speech(400),noise(1000)]));',
    ].join('');
    const result = await recordVadTurn({
      outputPath,
      mic: { command: fixtureCommand(script), sampleRateHz: 16000, chunkMs: 100 },
      endpointMs: 700,
      calibrationMs: 500,
      prerollMs: 300,
    });

    expect(result.noiseFloorRms as number).toBeGreaterThan(400);
    expect(result.rmsThreshold).toBeGreaterThan(1000); // lifted well above the noise
    expect(result.endpointed).toBe(true); // trailing noise reads as silence → endpoint fires
    // utterance = ≤300ms preroll + 400ms speech + 700ms endpoint, NOT the whole stream
    expect(result.durationMs).toBeLessThanOrEqual(1600);
  });

  it('rejects when the stream ends before any speech', async () => {
    await expect(
      recordVadTurn({
        outputPath: path.join(testDir, 'turn-none.wav'),
        mic: {
          command: fixtureCommand('process.stdout.write(Buffer.alloc(32000));'),
          sampleRateHz: 16000,
          chunkMs: 100,
        },
        rmsThreshold: 800,
      })
    ).rejects.toThrow(/before any speech/);
  });

  it('rejects after max wait when only silence is heard', async () => {
    await expect(
      recordVadTurn({
        outputPath: path.join(testDir, 'turn-wait.wav'),
        mic: {
          command: fixtureCommand('process.stdout.write(Buffer.alloc(64000));'),
          sampleRateHz: 16000,
          chunkMs: 100,
        },
        rmsThreshold: 800,
        maxWaitSeconds: 1,
      })
    ).rejects.toThrow(/no speech detected within 1s/);
  });
});
