import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  readPinFile,
  updatePinFile,
  writePinFile,
  pinSeamProviderDecision,
  loadSeamProviderPin,
} from './provider-pins-store.js';

const previousMission = process.env.MISSION_ID;
const mission = `MSN-PINS-STATE-${randomUUID()}`;
const file = pathResolver.rootResolve(`active/shared/runtime/provider-pins/${mission}.json`);
afterAll(() => {
  if (previousMission === undefined) delete process.env.MISSION_ID;
  else process.env.MISSION_ID = previousMission;
  safeRmSync(file, { force: true });
});

describe('provider pins through JsonStateStore (real governed I/O)', () => {
  it('preserves model pins across seam updates and validates mutations', () => {
    process.env.MISSION_ID = mission;
    writePinFile({
      version: '1.0',
      missionId: mission,
      pins: {
        implementation: {
          provider: 'codex',
          modelId: 'test',
          instance: null,
          orchestration: 'leaf',
          pinnedAt: '2026-10-21T00:00:00.000Z',
          by: 'test',
        },
      },
    });
    pinSeamProviderDecision('browser', 'navigation', 'chromium');
    expect(loadSeamProviderPin('browser', 'navigation')?.provider_id).toBe('chromium');
    expect(readPinFile().pins.implementation.provider).toBe('codex');
    const before = safeReadFile(file, { encoding: 'utf8' });
    expect(() => updatePinFile((current) => ({ ...current, version: '' }))).toThrow(
      'Invalid catalog'
    );
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe(before);
  });
  it('does not replace corrupt existing pins with an empty state during update', () => {
    process.env.MISSION_ID = mission;
    safeWriteFile(file, '{');
    expect(() => updatePinFile(() => ({ version: '1.0', pins: {} }))).toThrow();
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe('{');
  });
});
