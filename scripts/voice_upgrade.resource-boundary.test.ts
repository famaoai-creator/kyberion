import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { resolveVoiceProfileResourcePath } from './voice_upgrade.js';

const root = pathResolver.sharedTmp(`voice-upgrade-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('voice_upgrade resource boundary', () => {
  it('uses the governed existing profile JSON loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/voice_upgrade.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('readJson<Record<string, unknown>>(out)');
  });

  it('rejects repository-external profile resources', () => {
    expect(() => resolveVoiceProfileResourcePath('/tmp/voice-profile.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects symlinked profile resources', () => {
    const target = path.join(root, 'target');
    const link = path.join(root, 'profile.json');
    safeMkdir(target, { recursive: true });
    safeWriteFile(path.join(target, 'profile.json'), '{}\n');
    safeSymlinkSync(path.join(target, 'profile.json'), link);

    expect(() => resolveVoiceProfileResourcePath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
