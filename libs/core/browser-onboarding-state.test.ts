import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadBrowserOnboardingStateAtPath,
  writeBrowserOnboardingStateAtPath,
} from './browser-onboarding-state.js';
import {
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  withExecutionContext,
} from './index.js';

const fixtureRoot = pathResolver.sharedTmp(`browser-onboarding-state-${process.pid}`);

describe('browser onboarding state loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads a completion receipt through the path-bound catalog', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const filePath = path.join(fixtureRoot, 'browser-onboarding-state.json');
      safeWriteFile(
        filePath,
        JSON.stringify({
          version: '1.0.0',
          status: 'complete',
          applied_at: '2026-09-03T00:00:00.000Z',
          identity: { name: 'operator' },
          extension: { source: 'test' },
        })
      );

      expect(loadBrowserOnboardingStateAtPath(filePath)).toMatchObject({
        status: 'complete',
        identity: { name: 'operator' },
      });
    });
  });

  it('rejects an incomplete receipt before persisting it', () => {
    withExecutionContext('mission_controller', () => {
      const filePath = path.join(fixtureRoot, 'invalid-state.json');
      expect(() =>
        writeBrowserOnboardingStateAtPath(filePath, {
          version: '1.0.0',
          status: 'draft',
          applied_at: '2026-09-03T00:00:00.000Z',
        })
      ).toThrow(/Invalid catalog browser-onboarding-state/);
    });
  });

  it('returns null for malformed, directory, or symlink state', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const malformedPath = path.join(fixtureRoot, 'malformed.json');
      const directoryPath = path.join(fixtureRoot, 'directory.json');
      const targetPath = path.join(fixtureRoot, 'target.json');
      const linkedPath = path.join(fixtureRoot, 'linked.json');
      safeWriteFile(malformedPath, JSON.stringify({ version: '1.0.0', status: 'draft' }));
      safeMkdir(directoryPath);
      safeWriteFile(
        targetPath,
        JSON.stringify({ version: '1.0.0', status: 'complete', applied_at: 'now' })
      );
      safeSymlinkSync(targetPath, linkedPath);

      expect(loadBrowserOnboardingStateAtPath(malformedPath)).toBeNull();
      expect(loadBrowserOnboardingStateAtPath(directoryPath)).toBeNull();
      expect(loadBrowserOnboardingStateAtPath(linkedPath)).toBeNull();
    });
  });
});
