import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadMaxFileLinesConfig } from './max-file-lines-config.js';

const fixtureRoot = pathResolver.sharedTmp(`max-file-lines-config-${process.pid}`);

describe('max-file-lines config loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads the schema-valid config through the governed catalog', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const filePath = path.join(fixtureRoot, 'config.json');
    safeWriteFile(filePath, JSON.stringify({ max_lines: 120, roots: ['scripts'], exceptions: [] }));

    expect(loadMaxFileLinesConfig(filePath)).toEqual({
      max_lines: 120,
      roots: ['scripts'],
      exceptions: [],
    });
  });

  it('rejects schema-invalid, directory, and symlink configs', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const invalidPath = path.join(fixtureRoot, 'invalid.json');
    const directoryPath = path.join(fixtureRoot, 'directory.json');
    const targetPath = path.join(fixtureRoot, 'target.json');
    const linkedPath = path.join(fixtureRoot, 'linked.json');
    safeWriteFile(invalidPath, JSON.stringify({ max_lines: 0, roots: [], exceptions: [] }));
    safeMkdir(directoryPath);
    safeWriteFile(targetPath, JSON.stringify({ max_lines: 120, roots: [], exceptions: [] }));
    safeSymlinkSync(targetPath, linkedPath);

    expect(() => loadMaxFileLinesConfig(invalidPath)).toThrow(
      /Invalid catalog max-file-lines-config/
    );
    expect(() => loadMaxFileLinesConfig(directoryPath)).toThrow();
    expect(() => loadMaxFileLinesConfig(linkedPath)).toThrow();
  });
});
