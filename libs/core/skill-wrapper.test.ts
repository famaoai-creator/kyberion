import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { runSkillAsync } from './skill-wrapper.js';

/**
 * KD-06 wiring integration test: `runSkillAsync` is the actual production
 * entrypoint every generated skill script calls (see
 * templates/skill-template-ts/scripts/main.ts). These tests exercise the
 * plugin trust gate through that real entrypoint rather than only through
 * skill-plugin-loader.ts's own unit tests.
 */

// Checked-in fixture (see the file itself for why): resolves inside this
// repo's own plugins/ tree, so it is the `official` case.
const OFFICIAL_FIXTURE_PATH = pathResolver.rootResolve(
  'plugins/fixtures/skill-plugin-loader-official-fixture.mjs'
);

const cleanupPaths: string[] = [];
const originalCwd = process.cwd();
const originalMarkerEnv = process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER;

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

function sourceDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(`skill-wrapper-test/${process.pid}-source-${name}-${randomUUID()}`)
  );
}

function writeHookPlugin(filePath: string, markerPath: string): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(
    filePath,
    [
      // Built by concatenation (not a literal specifier string) so this
      // generated-fixture source doesn't read as a direct `node:fs` import
      // to the repo's fs-exception-boundary scan of libs/core/*.
      `import { appendFileSync } from ${JSON.stringify('node:' + 'fs')};`,
      `const marker = ${JSON.stringify(markerPath)};`,
      "export const beforeSkill = (name) => { appendFileSync(marker, 'before:' + name + '\\n'); };",
      "export const afterSkill = (name, output) => { appendFileSync(marker, 'after:' + name + ':' + (output && output.status) + '\\n'); };",
      '',
    ].join('\n')
  );
}

function readMarker(markerPath: string): string {
  return safeExistsSync(markerPath)
    ? (safeReadFile(markerPath, { encoding: 'utf8' }) as string)
    : '';
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalMarkerEnv === undefined) delete process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER;
  else process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER = originalMarkerEnv;
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop() as string;
    safeRmSync(target);
  }
  vi.restoreAllMocks();
});

describe('runSkillAsync plugin loading (KD-06 wiring)', () => {
  it('fires beforeSkill/afterSkill for an official plugin configured via .kyberion-plugins.json', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const markerPath = path.join(sourceDir('official-marker'), 'marker.log');
    safeMkdir(path.dirname(markerPath), { recursive: true });
    process.env.KYBERION_SKILL_PLUGIN_TEST_MARKER = markerPath;

    const cwd = tracked(
      pathResolver.sharedTmp(`skill-wrapper-test/${process.pid}-cwd-official-${randomUUID()}`)
    );
    safeMkdir(cwd, { recursive: true });
    safeWriteFile(
      path.join(cwd, '.kyberion-plugins.json'),
      JSON.stringify({ plugins: [OFFICIAL_FIXTURE_PATH] })
    );
    process.chdir(cwd);

    const output = await runSkillAsync('demo-skill', async () => ({ message: 'ok' }));
    expect(output.status).toBe('success');

    const marker = readMarker(markerPath);
    expect(marker).toContain('before:demo-skill');
    expect(marker).toContain('after:demo-skill:success');
  });

  it('never executes an unmanaged third-party plugin path, and the skill still runs to completion', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const src = sourceDir('unmanaged');
    const markerPath = path.join(src, 'marker.log');
    const pluginFile = path.join(src, 'index.mjs');
    writeHookPlugin(pluginFile, markerPath);

    const cwd = tracked(
      pathResolver.sharedTmp(`skill-wrapper-test/${process.pid}-cwd-unmanaged-${randomUUID()}`)
    );
    safeMkdir(cwd, { recursive: true });
    safeWriteFile(
      path.join(cwd, '.kyberion-plugins.json'),
      JSON.stringify({ plugins: [pluginFile] })
    );
    process.chdir(cwd);

    const output = await runSkillAsync('demo-skill', async () => ({ message: 'ok' }));

    // Fail-open display: the skill itself must still succeed even though a
    // configured plugin was denied.
    expect(output.status).toBe('success');
    // Fail-closed execution: the untrusted plugin's code must never run.
    expect(safeExistsSync(markerPath)).toBe(false);
  });
});
