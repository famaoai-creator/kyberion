import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  assertPluginAssetsContained,
  derivePluginTrustLabel,
  PluginTrustViolationError,
} from './plugin-source-trust.js';

const cleanupPaths: string[] = [];

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

function tmpDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(`plugin-source-trust-test/${process.pid}-${name}-${randomUUID()}`)
  );
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop() as string;
    safeRmSync(target);
  }
});

describe('derivePluginTrustLabel', () => {
  it("labels a path that resolves inside this repo's plugins/ tree as official", () => {
    const officialSample = pathResolver.rootResolve('plugins/kyberion');
    const result = derivePluginTrustLabel(officialSample);
    expect(result.label).toBe('official');
  });

  it('labels the same manifest content as third-party when it is not sourced from plugins/', () => {
    const dir = tmpDir('same-content');
    safeMkdir(dir, { recursive: true });
    // A manifest that self-declares "official" must be irrelevant — trust
    // comes only from `sourcePath`, and this function never even reads it.
    safeWriteFile(
      path.join(dir, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'duplicate-of-official', trust: 'official' })
    );

    const officialSample = pathResolver.rootResolve('plugins/kyberion');
    const officialResult = derivePluginTrustLabel(officialSample);
    const thirdPartyResult = derivePluginTrustLabel(dir);

    expect(officialResult.label).toBe('official');
    expect(thirdPartyResult.label).toBe('third-party');
  });

  it('labels a remote URL source as third-party unless it matches a configured curated origin', () => {
    expect(derivePluginTrustLabel('https://example.com/plugins/cool-plugin.zip').label).toBe(
      'third-party'
    );
    expect(
      derivePluginTrustLabel('https://curated.example.com/pkg.zip', {
        curatedOriginPrefixes: ['https://curated.example.com/'],
      }).label
    ).toBe('curated');
  });

  it('labels a local path matching a configured curated origin prefix as curated', () => {
    const dir = tmpDir('curated');
    safeMkdir(dir, { recursive: true });
    const result = derivePluginTrustLabel(dir, { curatedOriginPrefixes: [dir] });
    expect(result.label).toBe('curated');
  });

  it('rejects a source whose asset symlinks outside the plugin root', () => {
    const outsideDir = tmpDir('outside');
    safeMkdir(outsideDir, { recursive: true });
    safeWriteFile(path.join(outsideDir, 'secret.txt'), 'do-not-leak');

    const pluginRoot = tmpDir('escaping-root');
    safeMkdir(pluginRoot, { recursive: true });
    safeWriteFile(
      path.join(pluginRoot, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'escape' })
    );
    safeSymlinkSync(path.join(outsideDir, 'secret.txt'), path.join(pluginRoot, 'escape-link.txt'));

    expect(() => assertPluginAssetsContained(pluginRoot)).toThrow(PluginTrustViolationError);
  });

  it('allows a symlink whose target stays within the plugin root', () => {
    const pluginRoot = tmpDir('contained-root');
    safeMkdir(pluginRoot, { recursive: true });
    safeWriteFile(path.join(pluginRoot, 'real.txt'), 'content');
    safeSymlinkSync(path.join(pluginRoot, 'real.txt'), path.join(pluginRoot, 'alias.txt'));

    expect(() => assertPluginAssetsContained(pluginRoot)).not.toThrow();
  });

  it('rejects a symlinked directory even when its target is contained', () => {
    const pluginRoot = tmpDir('dir-symlink-root');
    safeMkdir(pluginRoot, { recursive: true });
    const realSubdir = path.join(pluginRoot, 'real-subdir');
    safeMkdir(realSubdir, { recursive: true });
    safeWriteFile(path.join(realSubdir, 'file.txt'), 'content');
    safeSymlinkSync(realSubdir, path.join(pluginRoot, 'alias-subdir'));

    // Symlinked *directories* are always rejected (never traversed) to avoid
    // cross-linking games — only symlinked regular files are tolerated.
    expect(() => assertPluginAssetsContained(pluginRoot)).toThrow(PluginTrustViolationError);
  });
});
