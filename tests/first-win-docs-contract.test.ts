import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('First-win documentation contract', () => {
  it('keeps README on the 30s / 5m / 15m first-win ladder', () => {
    const readme = read('README.md');
    expect(readme).toContain('30 seconds: run `pnpm doctor`');
    expect(readme).toContain('5 minutes: run the voice smoke');
    expect(readme).toContain('15 minutes: run the browser session smoke');
    expect(readme).toContain('pnpm pipeline --input pipelines/voice-hello.json');
    expect(readme).toContain('pnpm pipeline --input pipelines/verify-session.json');
  });

  it('keeps the quickstart aligned with the same ladder and commands', () => {
    const quickstart = read('docs/QUICKSTART.md');
    expect(quickstart).toContain('30 seconds: `pnpm doctor`');
    expect(quickstart).toContain('5 minutes: `pnpm pipeline --input pipelines/voice-hello.json`');
    expect(quickstart).toContain('15 minutes: `pnpm pipeline --input pipelines/enterprise-login.json` then `pnpm pipeline --input pipelines/verify-session.json`');
  });

  it('points WHY readers to the same first-win path', () => {
    const why = read('docs/WHY.md');
    expect(why).toContain('first-win ladder');
    expect(why).toContain('30 seconds for `pnpm doctor`');
    expect(why).toContain('5 minutes for `pipelines/voice-hello.json`');
    expect(why).toContain('15 minutes for the browser-session smoke');
  });
});
