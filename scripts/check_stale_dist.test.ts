import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  findStaleDistTargets,
  formatStaleDistWarning,
  type StaleTargetSpec,
} from './check_stale_dist.js';

const FIXTURE_ROOT = 'active/shared/tmp/check-stale-dist';
const FIXTURE_DIR = pathResolver.sharedTmp('check-stale-dist');

function write(relativePath: string, contents = '// fixture\n'): string {
  const fullPath = pathResolver.sharedTmp(`check-stale-dist/${relativePath}`);
  safeMkdir(path.dirname(fullPath), { recursive: true });
  safeWriteFile(fullPath, contents);
  return fullPath;
}

function setMtime(relativePath: string, ms: number): void {
  const fullPath = pathResolver.sharedTmp(`check-stale-dist/${relativePath}`);
  const t = new Date(ms);
  fs.utimesSync(fullPath, t, t);
}

const T_OLD = 1_000_000;
const T_NEW = 2_000_000;

describe('check_stale_dist', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  function spec(overrides: Partial<StaleTargetSpec> = {}): StaleTargetSpec {
    return {
      id: 'fixture',
      sourceRoot: `${FIXTURE_ROOT}/src`,
      distRoot: `${FIXTURE_ROOT}/dist`,
      ...overrides,
    };
  }

  it('reports clean when dist is newer than every source', () => {
    write('src/a.ts');
    write('dist/a.js');
    setMtime('src/a.ts', T_OLD);
    setMtime('dist/a.js', T_NEW);

    const scan = findStaleDistTargets({ targets: [spec()] });
    expect(scan.stale).toEqual([]);
    expect(scan.checked).toBe(1);
  });

  it('flags a source file newer than every dist artifact', () => {
    write('src/a.ts');
    write('dist/a.js');
    setMtime('src/a.ts', T_NEW);
    setMtime('dist/a.js', T_OLD);

    const scan = findStaleDistTargets({ targets: [spec()] });
    expect(scan.stale).toHaveLength(1);
    expect(scan.stale[0].reason).toBe('source_newer_than_dist');
    expect(scan.stale[0].source_file).toBe(`${FIXTURE_ROOT}/src/a.ts`);
  });

  it('ignores *.test.ts when excludeTests is set', () => {
    write('src/a.ts');
    write('src/a.test.ts');
    write('dist/a.js');
    setMtime('src/a.ts', T_OLD);
    setMtime('src/a.test.ts', T_NEW);
    setMtime('dist/a.js', T_OLD + 500_000);

    const scan = findStaleDistTargets({ targets: [spec({ excludeTests: true })] });
    expect(scan.stale).toEqual([]);

    const scanWithTests = findStaleDistTargets({ targets: [spec()] });
    expect(scanWithTests.stale[0].source_file).toBe(`${FIXTURE_ROOT}/src/a.test.ts`);
  });

  it('ignores excluded source subdirectories', () => {
    write('src/keep/a.ts');
    write('src/displays/standalone/b.ts');
    write('dist/a.js');
    setMtime('src/keep/a.ts', T_OLD);
    setMtime('src/displays/standalone/b.ts', T_NEW);
    setMtime('dist/a.js', T_OLD + 500_000);

    const scan = findStaleDistTargets({
      targets: [spec({ excludeSourceDirs: ['displays/standalone'] })],
    });
    expect(scan.stale).toEqual([]);
  });

  it('reports dist_missing when dist exists but has no .js', () => {
    write('src/a.ts');
    write('dist/.gitkeep');
    setMtime('src/a.ts', T_NEW);

    const scan = findStaleDistTargets({ targets: [spec()] });
    expect(scan.stale[0].reason).toBe('dist_missing');
  });

  it('skips targets whose dist root does not exist', () => {
    write('src/a.ts');

    const scan = findStaleDistTargets({
      targets: [spec({ distRoot: `${FIXTURE_ROOT}/no-dist` })],
    });
    expect(scan.stale).toEqual([]);
    expect(scan.checked).toBe(1);
  });

  function writeBuildInfo(relativePath: string, entries: Record<string, string>): void {
    const buildInfoPath = pathResolver.sharedTmp(`check-stale-dist/${relativePath}`);
    const baseDir = path.dirname(buildInfoPath);
    const fileNames = Object.keys(entries).map((abs) => path.relative(baseDir, abs));
    const fileInfos = Object.values(entries).map((version) => ({ version }));
    write(relativePath, JSON.stringify({ fileNames, fileInfos }));
  }

  function sha256(contents: string): string {
    return createHash('sha256').update(contents, 'utf8').digest('hex');
  }

  it('clears a touched-but-unchanged source via tsbuildinfo content hash (incremental rebuild saw it)', () => {
    // Composite builds skip re-emitting identical files and may not even bump
    // mtimes — content hash, not mtime, proves the build saw this file.
    write('src/a.ts', 'const a = 1;\n');
    write('dist/a.js');
    writeBuildInfo('.tsbuildinfo', {
      [pathResolver.sharedTmp('check-stale-dist/src/a.ts')]: sha256('const a = 1;\n'),
    });
    setMtime('src/a.ts', T_NEW);
    setMtime('dist/a.js', T_OLD);
    setMtime('.tsbuildinfo', T_OLD);

    const scan = findStaleDistTargets({
      targets: [spec({ buildInfo: [`${FIXTURE_ROOT}/.tsbuildinfo`] })],
    });
    expect(scan.stale).toEqual([]);
  });

  it('flags a content change even when mtimes still look fresh', () => {
    write('src/a.ts', 'const a = 2;\n');
    write('dist/a.js');
    writeBuildInfo('.tsbuildinfo', {
      [pathResolver.sharedTmp('check-stale-dist/src/a.ts')]: sha256('const a = 1;\n'),
    });
    setMtime('src/a.ts', T_OLD);
    setMtime('dist/a.js', T_NEW);
    setMtime('.tsbuildinfo', T_NEW);

    const scan = findStaleDistTargets({
      targets: [spec({ buildInfo: [`${FIXTURE_ROOT}/.tsbuildinfo`] })],
    });
    expect(scan.stale).toHaveLength(1);
    expect(scan.stale[0].reason).toBe('source_changed_since_build');
  });

  it('flags a source file the last build never recorded', () => {
    write('src/a.ts', 'const a = 1;\n');
    write('src/new.ts', 'const b = 1;\n');
    write('dist/a.js');
    writeBuildInfo('.tsbuildinfo', {
      [pathResolver.sharedTmp('check-stale-dist/src/a.ts')]: sha256('const a = 1;\n'),
    });
    setMtime('dist/a.js', T_NEW);
    setMtime('.tsbuildinfo', T_NEW);

    const scan = findStaleDistTargets({
      targets: [spec({ buildInfo: [`${FIXTURE_ROOT}/.tsbuildinfo`] })],
    });
    expect(scan.stale).toHaveLength(1);
    expect(scan.stale[0].reason).toBe('unrecorded_source');
    expect(scan.stale[0].source_file).toBe(`${FIXTURE_ROOT}/src/new.ts`);
  });

  it('ignores declaration variants and *.test.tsx under excludeTests', () => {
    write('src/a.ts');
    write('src/a.test.tsx');
    write('src/boundary.d.mts');
    write('src/types.d.cts');
    write('dist/a.js');
    setMtime('src/a.ts', T_OLD);
    setMtime('src/a.test.tsx', T_NEW);
    setMtime('src/boundary.d.mts', T_NEW);
    setMtime('src/types.d.cts', T_NEW);
    setMtime('dist/a.js', T_OLD + 500_000);

    const scan = findStaleDistTargets({ targets: [spec({ excludeTests: true })] });
    expect(scan.stale).toEqual([]);
  });

  it('does not flag an unrecorded file older than the buildinfo (out-of-program file)', () => {
    // The shared dist/.tsbuildinfo mixes build:repo and build:actuators
    // programs — a file that predates the build but is not in fileInfos is
    // outside that program, not stale.
    write('src/tracked.ts', 'const a = 1;\n');
    write('src/outside.ts', 'const o = 1;\n');
    write('dist/a.js');
    writeBuildInfo('.tsbuildinfo', {
      [pathResolver.sharedTmp('check-stale-dist/src/tracked.ts')]: sha256('const a = 1;\n'),
    });
    setMtime('src/tracked.ts', T_OLD);
    setMtime('src/outside.ts', T_OLD);
    setMtime('dist/a.js', T_OLD);
    setMtime('.tsbuildinfo', T_NEW);

    const scan = findStaleDistTargets({
      targets: [spec({ buildInfo: [`${FIXTURE_ROOT}/.tsbuildinfo`] })],
    });
    expect(scan.stale).toEqual([]);
  });

  it('keeps flagging when a foreign buildinfo was written after the source edit', () => {
    // build:actuators writing dist/.tsbuildinfo last must not mask a real
    // scripts/ staleness — its mtime only counts when it tracks sourceRoot.
    write('src/a.ts', 'const a = 2;\n');
    write('dist/a.js');
    writeBuildInfo('.tsbuildinfo', {
      [pathResolver.sharedTmp('check-stale-dist/other-program/x.ts')]: sha256('x'),
    });
    // Source edit lands between the last real emit and the foreign buildinfo
    // write — counting the foreign mtime would mask the staleness.
    setMtime('src/a.ts', T_OLD + 500_000);
    setMtime('dist/a.js', T_OLD);
    setMtime('.tsbuildinfo', T_NEW);

    const scan = findStaleDistTargets({
      targets: [spec({ buildInfo: [`${FIXTURE_ROOT}/.tsbuildinfo`] })],
    });
    expect(scan.stale).toHaveLength(1);
    expect(scan.stale[0].reason).toBe('source_newer_than_dist');
  });

  it('falls back to mtime when buildinfo tracks no files under the source root', () => {
    write('src/a.ts');
    write('dist/a.js');
    writeBuildInfo('.tsbuildinfo', {
      [pathResolver.sharedTmp('check-stale-dist/unrelated/x.ts')]: sha256('x'),
    });
    setMtime('src/a.ts', T_NEW);
    setMtime('dist/a.js', T_OLD);
    setMtime('.tsbuildinfo', T_OLD);

    const scan = findStaleDistTargets({
      targets: [spec({ buildInfo: [`${FIXTURE_ROOT}/.tsbuildinfo`] })],
    });
    expect(scan.stale).toHaveLength(1);
    expect(scan.stale[0].reason).toBe('source_newer_than_dist');
  });

  it('formats a warning naming the stale target and the rebuild fix', () => {
    write('src/a.ts');
    write('dist/a.js');
    setMtime('src/a.ts', T_NEW);
    setMtime('dist/a.js', T_OLD);

    const scan = findStaleDistTargets({ targets: [spec()] });
    const warning = formatStaleDistWarning(scan);
    expect(warning).toContain('pnpm run build');
    expect(warning).toContain('fixture');
  });
});
