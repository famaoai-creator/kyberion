import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileSecretProvider, SecretPolicyRouter } from './secret-bridge.js';
import { logger } from './core.js';

let testRoot: string;
let secretsDir: string;
let secretsFile: string;

function removeIsolatedTestRoot(): void {
  const allowedRoot = path.join(process.cwd(), 'active', 'shared', 'tmp', 'tests');
  const relative = path.relative(allowedRoot, testRoot);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !relative.startsWith('file-secrets-test-')
  ) {
    throw new Error(`Refusing to clean non-isolated secret test path: ${testRoot}`);
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
}

beforeEach(() => {
  const tmpRoot = path.join(process.cwd(), 'active', 'shared', 'tmp', 'tests');
  fs.mkdirSync(tmpRoot, { recursive: true });
  testRoot = fs.mkdtempSync(path.join(tmpRoot, 'file-secrets-test-'));
  secretsDir = path.join(testRoot, 'secrets');
  secretsFile = path.join(secretsDir, 'file-secrets.json');
});

afterEach(() => {
  removeIsolatedTestRoot();
});

describe('FileSecretProvider', () => {
  it('keeps its fixture and cleanup target inside the governed test temp root', () => {
    expect(testRoot).toContain(
      `${path.sep}active${path.sep}shared${path.sep}tmp${path.sep}tests${path.sep}`
    );
    expect(secretsFile).toBe(path.join(testRoot, 'secrets', 'file-secrets.json'));
    expect(testRoot).not.toContain(`${path.sep}vault${path.sep}`);
  });

  it('enforces private directory and file modes independently of umask', async () => {
    const previousUmask = process.umask(0);
    try {
      (new FileSecretProvider(secretsFile) as any).writeSecretsFile({
        'test-service': { 'test-account': 'secret' },
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it('repairs permissive modes left by an older version', async () => {
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o777 });
    fs.writeFileSync(secretsFile, '{}', { mode: 0o666 });
    fs.chmodSync(secretsDir, 0o777);
    fs.chmodSync(secretsFile, 0o666);

    (new FileSecretProvider(secretsFile) as any).writeSecretsFile({
      'test-service': { 'test-account': 'secret' },
    });

    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it('refuses a symbolic-link secret file', async () => {
    fs.mkdirSync(secretsDir, { recursive: true });
    const target = path.join(testRoot, 'secret-target.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, secretsFile);
    try {
      expect(() =>
        (new FileSecretProvider(secretsFile) as any).writeSecretsFile({
          service: { account: 'secret' },
        })
      ).toThrow('secret file symbolic link');
    } finally {
      fs.rmSync(target, { force: true });
    }
  });
});

describe('SecretPolicyRouter file fallback warn phase', () => {
  it('warns once when file secrets engage without KYBERION_ALLOW_FILE_SECRETS', async () => {
    const previous = process.env.KYBERION_ALLOW_FILE_SECRETS;
    delete process.env.KYBERION_ALLOW_FILE_SECRETS;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const router = new SecretPolicyRouter([new FileSecretProvider(secretsFile)]);
      const provider = await router.selectProvider();
      expect(provider.id).toBe('file_secrets');
      const fallbackWarnings = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes('plaintext file secrets')
      );
      expect(fallbackWarnings).toHaveLength(1);

      warnSpy.mockClear();
      await router.selectProvider();
      expect(
        warnSpy.mock.calls.filter(([message]) => String(message).includes('plaintext file secrets'))
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      if (previous === undefined) delete process.env.KYBERION_ALLOW_FILE_SECRETS;
      else process.env.KYBERION_ALLOW_FILE_SECRETS = previous;
    }
  });
});
