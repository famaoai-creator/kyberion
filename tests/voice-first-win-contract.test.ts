import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Voice first-win contract', () => {
  it('keeps implemented system ops out of the TODO list', () => {
    const doc = read('docs/developer/VOICE_FIRST_WIN.md');
    expect(doc).toContain('[x] `system:native_tts_speak`');
    expect(doc).toContain('[x] `system:check_native_tts`');
    expect(doc).not.toContain('Currently the pipeline references this op symbolically');
    expect(doc).not.toContain('The wiring is the next concrete TODO');
  });
});
