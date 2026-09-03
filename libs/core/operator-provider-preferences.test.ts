import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { loadOperatorProviderPreferencesAtPath } from './operator-provider-preferences.js';
import {
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  withExecutionContext,
} from './index.js';

const fixtureRoot = pathResolver.sharedTmp(`operator-provider-preferences-${process.pid}`);

describe('operator provider preferences loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads an extensible preference record from a regular repository file', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const filePath = path.join(fixtureRoot, 'provider-preferences.json');
      safeWriteFile(
        filePath,
        JSON.stringify({
          version: '1.0.0',
          priority: ['codex', 'claude'],
          default_models: { codex: 'gpt-5.6-sol' },
          extension: { owner: 'operator' },
        })
      );

      expect(loadOperatorProviderPreferencesAtPath(filePath)).toMatchObject({
        priority: ['codex', 'claude'],
        default_models: { codex: 'gpt-5.6-sol' },
      });
    });
  });

  it('returns null for malformed, directory, or symlink preferences', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const malformedPath = path.join(fixtureRoot, 'malformed.json');
      const directoryPath = path.join(fixtureRoot, 'directory.json');
      const targetPath = path.join(fixtureRoot, 'target.json');
      const linkedPath = path.join(fixtureRoot, 'linked.json');
      safeWriteFile(malformedPath, JSON.stringify({ priority: ['codex', 42] }));
      safeMkdir(directoryPath);
      safeWriteFile(targetPath, JSON.stringify({ priority: ['codex'] }));
      safeSymlinkSync(targetPath, linkedPath);

      expect(loadOperatorProviderPreferencesAtPath(malformedPath)).toBeNull();
      expect(loadOperatorProviderPreferencesAtPath(directoryPath)).toBeNull();
      expect(loadOperatorProviderPreferencesAtPath(linkedPath)).toBeNull();
    });
  });
});
