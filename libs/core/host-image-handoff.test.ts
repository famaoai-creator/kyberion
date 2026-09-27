import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHostImageHandoffOutput, recordHostImageHandoffRequest } from './host-image-handoff.js';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('host image hand-off bookkeeping', () => {
  let dir = '';
  let rel = (name: string) => name;
  beforeAll(() => {
    dir = pathResolver.sharedTmp(`host-handoff-test-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    rel = (name) => path.relative(pathResolver.rootDir(), path.join(dir, name));
  });
  afterAll(() => safeRmSync(dir, { recursive: true, force: true }));

  const request = (target: string, prompt: string) =>
    recordHostImageHandoffRequest({ providerId: 'host_agent', targetPath: target, prompt });

  it('never attributes a file that was already there to the host', () => {
    safeWriteFile(path.join(dir, 'existing.png'), 'old');
    expect(isHostImageHandoffOutput(rel('existing.png'), 'a fox')).toBe(false);
    request(rel('existing.png'), 'a fox');
    expect(isHostImageHandoffOutput(rel('existing.png'), 'a fox')).toBe(false);
    safeWriteFile(path.join(dir, 'existing.png'), 'host output');
    expect(isHostImageHandoffOutput(rel('existing.png'), 'a fox')).toBe(true);
  });

  it('collects idempotently (multi-pass resume) and only for the same prompt', () => {
    request(rel('fox.png'), 'a fox');
    expect(isHostImageHandoffOutput(rel('fox.png'), 'a fox')).toBe(false); // not saved yet
    safeWriteFile(path.join(dir, 'fox.png'), 'host output');
    expect(isHostImageHandoffOutput(rel('fox.png'), 'a wolf')).toBe(false);
    expect(isHostImageHandoffOutput(rel('fox.png'), 'a fox')).toBe(true);
    expect(isHostImageHandoffOutput(rel('fox.png'), 'a fox')).toBe(true);
  });

  it('keeps the original request when re-requested, so a file written in between is not orphaned', () => {
    request(rel('race.png'), 'p');
    safeWriteFile(path.join(dir, 'race.png'), 'host output'); // host answers ...
    request(rel('race.png'), 'p'); // ... while a rerun re-requests
    expect(isHostImageHandoffOutput(rel('race.png'), 'p')).toBe(true);
  });

  it('resolves relative and absolute targets to the same request', () => {
    request(rel('abs.png'), 'p');
    safeWriteFile(path.join(dir, 'abs.png'), 'host output');
    expect(isHostImageHandoffOutput(path.join(dir, 'abs.png'), 'p')).toBe(true);
  });

  it('identical content is not an answer; a changed file is, whatever its timestamps', () => {
    safeWriteFile(path.join(dir, 'same.png'), 'bytes');
    request(rel('same.png'), 'p');
    safeWriteFile(path.join(dir, 'same.png'), 'bytes'); // rewritten, same content
    expect(isHostImageHandoffOutput(rel('same.png'), 'p')).toBe(false);
    safeWriteFile(path.join(dir, 'same.png'), 'BYTES'); // same size, new content
    expect(isHostImageHandoffOutput(rel('same.png'), 'p')).toBe(true);
  });

  it('a new prompt needs a new host write', () => {
    request(rel('swap.png'), 'first');
    safeWriteFile(path.join(dir, 'swap.png'), 'first answer');
    request(rel('swap.png'), 'second');
    expect(isHostImageHandoffOutput(rel('swap.png'), 'second')).toBe(false);
    safeWriteFile(path.join(dir, 'swap.png'), 'second answer!');
    expect(isHostImageHandoffOutput(rel('swap.png'), 'second')).toBe(true);
  });
});
