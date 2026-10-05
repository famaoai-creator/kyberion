import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  assertOperationsNotHalted,
  engageOperationsHalt,
  getOperationsHaltState,
  isOperationsHalted,
  OperationsHaltedError,
  releaseOperationsHalt,
} from './operations-halt.js';

describe('operations-halt', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = pathResolver.sharedTmp(`operations-halt-test-${process.pid}-${Date.now()}`);
    safeMkdir(dir, { recursive: true });
    file = path.join(dir, 'operations-halt.json');
  });

  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('is not halted when no flag exists', () => {
    expect(getOperationsHaltState({ rootDir: file })).toEqual({ halted: false });
    expect(isOperationsHalted({ rootDir: file })).toBe(false);
    expect(() => assertOperationsNotHalted({ rootDir: file })).not.toThrow();
  });

  it('engages once, records who and why, and is idempotent', () => {
    const first = engageOperationsHalt({ by: 'telegram:42', reason: 'runaway', rootDir: file });
    expect(first.changed).toBe(true);
    expect(first.state).toMatchObject({ halted: true, by: 'telegram:42', reason: 'runaway' });
    const second = engageOperationsHalt({ by: 'slack:7', rootDir: file });
    expect(second.changed).toBe(false);
    expect(getOperationsHaltState({ rootDir: file })).toMatchObject({ by: 'telegram:42' });
  });

  it('makes the guard throw while halted and stop throwing after release', () => {
    engageOperationsHalt({ by: 'operator:cli', rootDir: file });
    expect(() => assertOperationsNotHalted({ rootDir: file })).toThrow(OperationsHaltedError);
    const released = releaseOperationsHalt({ by: 'operator:cli', rootDir: file });
    expect(released.changed).toBe(true);
    expect(isOperationsHalted({ rootDir: file })).toBe(false);
    expect(releaseOperationsHalt({ by: 'operator:cli', rootDir: file }).changed).toBe(false);
  });

  it('fails closed when the flag file is unreadable', () => {
    safeWriteFile(file, '{not json');
    const state = getOperationsHaltState({ rootDir: file });
    expect(state).toMatchObject({ halted: true, unreadable: true });
    // Engaging over a corrupt flag repairs it into a readable halt.
    expect(engageOperationsHalt({ by: 'operator:cli', rootDir: file }).changed).toBe(true);
    expect(getOperationsHaltState({ rootDir: file }).unreadable).toBeUndefined();
  });
});
