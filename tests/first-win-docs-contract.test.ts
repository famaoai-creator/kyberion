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
    expect(readme).toContain("30 seconds: run `pnpm doctor` and see Kyberion's readiness/value boundary");
    expect(readme).toContain('5 minutes: run the clean browser smoke and get `active/shared/tmp/first-win-session.png`');
    expect(readme).toContain('15 minutes: read the Quickstart structure map');
    expect(readme).toContain('pnpm pipeline --input pipelines/voice-hello.json');
    expect(readme).toContain('pnpm pipeline --input pipelines/verify-session.json');
    expect(readme).toContain('docs/developer/EXTENSION_POINTS.md');
  });

  it('keeps the quickstart aligned with the same ladder and commands', () => {
    const quickstart = read('docs/QUICKSTART.md');
    expect(quickstart).toContain('30 seconds: `pnpm doctor` shows whether the local runtime is ready');
    expect(quickstart).toContain('5 minutes: `pnpm pipeline --input pipelines/verify-session.json` writes `active/shared/tmp/first-win-session.png`');
    expect(quickstart).toContain('15 minutes: skim sections 4-10');
    expect(quickstart).toContain('CAPABILITIES_GUIDE.md');
    expect(quickstart).toContain('docs/developer/EXTENSION_POINTS.md');
  });

  it('points WHY readers to the same first-win path', () => {
    const why = read('docs/WHY.md');
    expect(why).toContain('first-win ladder');
    expect(why).toContain('30 seconds for `pnpm doctor`');
    expect(why).toContain('5 minutes for `pipelines/verify-session.json`');
    expect(why).toContain('15 minutes to understand the structure');
  });
});
