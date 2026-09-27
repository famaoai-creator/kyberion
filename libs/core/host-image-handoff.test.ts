import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimHostImageHandoffOutput,
  recordHostImageHandoffRequest,
} from './host-image-handoff.js';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('host image hand-off bookkeeping', () => {
  let dir = '';
  beforeAll(() => {
    dir = pathResolver.sharedTmp(`host-handoff-test-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
  });
  afterAll(() => safeRmSync(dir, { recursive: true, force: true }));

  it('never attributes a file that was already there to the host', () => {
    const target = path.join(dir, 'existing.png');
    safeWriteFile(target, 'old');
    expect(claimHostImageHandoffOutput(target, 'a fox')).toBe(false);
  });

  it('claims a file written after the request with the same prompt, once', () => {
    const target = path.join(dir, 'fox.png');
    recordHostImageHandoffRequest({
      providerId: 'host_agent',
      targetPath: target,
      prompt: 'a fox',
      nowMs: Date.now() - 1_000,
    });
    expect(claimHostImageHandoffOutput(target, 'a fox')).toBe(false); // not saved yet
    safeWriteFile(target, 'host output');
    expect(claimHostImageHandoffOutput(target, 'a wolf')).toBe(false);
    expect(claimHostImageHandoffOutput(target, 'a fox')).toBe(true);
    expect(claimHostImageHandoffOutput(target, 'a fox')).toBe(false);
  });

  it('does not claim a file older than the request', () => {
    const target = path.join(dir, 'stale.png');
    safeWriteFile(target, 'before');
    recordHostImageHandoffRequest({
      providerId: 'host_agent',
      targetPath: target,
      prompt: 'p',
      nowMs: Date.now() + 60_000,
    });
    expect(claimHostImageHandoffOutput(target, 'p')).toBe(false);
  });
});
