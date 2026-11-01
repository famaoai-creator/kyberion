import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRegisteredEnvText, setRegisteredEnv } from './foundation/env.js';
import {
  assertSensitiveMetadataAllowed,
  assertSensitivePathAllowed,
  findSensitivePathInText,
  findSensitivePathMatch,
  getSensitivePathRuleIds,
  withBackupCredentialReadAdmission,
} from './sensitive-path-policy.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir } from './secure-io.js';

describe('sensitive-path-policy', () => {
  it('keeps the OH-02 credential registry explicit and unique', () => {
    const ids = getSensitivePathRuleIds();
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['ssh', '~/.ssh/id_ed25519'],
    ['aws', '$HOME/.aws/credentials'],
    ['kube', '${HOME}/.kube/config'],
    ['gnupg', path.join(os.homedir(), '.gnupg/private-keys-v1.d/key.key')],
    ['claude', path.join(os.homedir(), '.claude/.credentials.json')],
    ['codex', path.join(os.homedir(), '.codex/auth.json')],
  ])('matches %s credential paths', (_name, candidate) => {
    expect(findSensitivePathMatch(candidate)?.ruleId).toContain('credential.');
  });

  describe('relative paths from another working directory', () => {
    const originalCwd = process.cwd();
    afterEach(() => {
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
    });

    it.each([
      ['safeReaddir', (p: string) => safeReaddir(p)],
      ['safeLstat', (p: string) => safeLstat(p)],
      ['safeExistsSync', (p: string) => safeExistsSync(p)],
    ])('%s judges the project-root resolution, not the cwd one', (_name, probe) => {
      vi.stubEnv('KYBERION_ROOT', pathResolver.rootDir());
      process.chdir(path.join(pathResolver.rootDir(), 'libs'));
      expect(() => probe('knowledge/personal/connections')).toThrow('[SENSITIVE_PATH_DENIED]');
    });
  });

  describe('backup credential read admission', () => {
    const connection = path.resolve('knowledge/personal/connections/slack.json');
    const vaultSecret = path.resolve('vault/secrets/keychain-registry.json');

    it('denies every caller outside the admission', () => {
      expect(() => assertSensitivePathAllowed(connection, 'read')).toThrow(
        '[SENSITIVE_PATH_DENIED]'
      );
    });

    it('admits metadata probes of connection documents only, and only while the walk runs', () => {
      const roots = withBackupCredentialReadAdmission({ encrypted: true }, (admitted) => {
        expect(() => assertSensitiveMetadataAllowed(connection)).not.toThrow();
        expect(() => assertSensitiveMetadataAllowed(vaultSecret)).toThrow(
          '[SENSITIVE_PATH_DENIED]'
        );
        // Content stays denied inside the admission: tar reads the bytes.
        expect(() => safeReadFile(connection)).toThrow('[SENSITIVE_PATH_DENIED]');
        for (const operation of ['read', 'write', 'append', 'mkdir', 'read/write']) {
          expect(() => assertSensitivePathAllowed(connection, operation)).toThrow(
            '[SENSITIVE_PATH_DENIED]'
          );
        }
        expect(() => assertSensitivePathAllowed(vaultSecret, 'read')).toThrow(
          '[SENSITIVE_PATH_DENIED]'
        );
        expect(() => withBackupCredentialReadAdmission({ encrypted: true }, () => 0)).toThrow(
          '[BACKUP_CREDENTIAL_READ_NESTED]'
        );
        return admitted.map(({ ruleId }) => ruleId);
      });
      expect(roots).toEqual(['credential.kyberion-connections']);
      expect(() => assertSensitiveMetadataAllowed(connection)).toThrow('[SENSITIVE_PATH_DENIED]');
    });

    it('refuses an unencrypted archive before admitting anything', () => {
      let ran = false;
      expect(() =>
        withBackupCredentialReadAdmission({ encrypted: false }, () => {
          ran = true;
        })
      ).toThrow('[BACKUP_CREDENTIAL_READ_REQUIRES_ENCRYPTION]');
      expect(ran).toBe(false);
    });
  });

  it('matches Kyberion OAuth storage and shell text while leaving project temp paths alone', () => {
    expect(
      findSensitivePathMatch(path.resolve('knowledge/personal/connections/slack.json'))?.ruleId
    ).toBe('credential.kyberion-connections');
    expect(findSensitivePathMatch(path.resolve('vault/secrets/secrets.json'))?.ruleId).toBe(
      'credential.kyberion-vault'
    );
    expect(findSensitivePathInText('cat ~/.ssh/id_ed25519')?.ruleId).toBe('credential.ssh');
    expect(findSensitivePathMatch(path.resolve('active/shared/tmp/example.txt'))).toBeNull();
  });

  it('rebuilds credential roots when HOME changes', () => {
    const originalHome = os.homedir();
    const originalHomeEnv = getRegisteredEnvText('HOME');
    const probeHome = '/kyberion-sensitive-path-cache-probe';
    try {
      setRegisteredEnv('HOME', probeHome);
      expect(findSensitivePathMatch(`${probeHome}/.ssh/id_ed25519`)?.ruleId).toBe('credential.ssh');
      expect(findSensitivePathMatch(path.join(originalHome, '.ssh/id_ed25519'))).toBeNull();
    } finally {
      setRegisteredEnv('HOME', originalHomeEnv);
    }
    expect(findSensitivePathMatch(path.join(originalHome, '.ssh/id_ed25519'))?.ruleId).toBe(
      'credential.ssh'
    );
  });

  it('resolves the home root through the registered environment boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/sensitive-path-policy.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("getRegisteredEnvText('HOME')");
    expect(source).not.toContain('process.env.HOME');
  });
});
