import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tenant: undefined as string | undefined,
  plugin: undefined as object | undefined,
  write: vi.fn(),
}));
vi.mock('../core.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../secure-io.js', () => ({
  withSensitivePathMediation: <T>(run: () => T) => run(),
  assertSafeRepositoryPath: (file: string) => file,
  safeExistsSync: (file: string) => mocks.files.has(file),
  safeReaddir: () => [],
  safeWriteFile: (file: string, data: string, options: unknown) => {
    mocks.write(file, data, options);
    mocks.files.set(file, data);
  },
}));
vi.mock('../foundation/json.js', () => ({
  readJson: (file: string) => {
    const data = mocks.files.get(file);
    if (!data) throw new Error('ENOENT');
    return JSON.parse(data);
  },
}));
vi.mock('../foundation/credential-binding.js', () => ({
  credentialExecutionIdentity: () => ({ tenantSlug: mocks.tenant }),
}));
vi.mock('../shell/sandbox-policy.js', () => ({
  getPluginExecutionContext: () => mocks.plugin,
}));
vi.mock('../governance/ledger.js', () => ({ ledger: { record: vi.fn() } }));
vi.mock('../path-resolver.js', () => ({ resolve: (file: string) => `/repo/${file}` }));

import { loadLocalAccountMaterial, storeLocalAccountMaterial } from './secret-guard.js';
import { overrideSecretEncryptionKeyForTests } from './secret-encryption.js';

const alice = {
  serviceId: 'slack',
  bindingId: 'alice-work',
  ownerKind: 'person' as const,
  ownerRef: 'user:alice',
};
beforeEach(() => {
  mocks.files.clear();
  mocks.write.mockClear();
  mocks.tenant = undefined;
  mocks.plugin = undefined;
  overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 7));
});
afterEach(() => overrideSecretEncryptionKeyForTests(null));

describe('internal local account material storage', () => {
  it('isolates accounts of the same service and generations without an ambient default', () => {
    const a = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'alice-secret' });
    const b = storeLocalAccountMaterial(
      { ...alice, bindingId: 'bob-work', ownerRef: 'user:bob' },
      { SLACK_TOKEN: 'bob-secret' }
    );
    const newer = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'rotated-secret' });
    expect(a.generation).not.toBe(newer.generation);
    expect(loadLocalAccountMaterial(a)).toEqual({ SLACK_TOKEN: 'alice-secret' });
    expect(loadLocalAccountMaterial(b)).toEqual({ SLACK_TOKEN: 'bob-secret' });
    expect(loadLocalAccountMaterial(newer)).toEqual({ SLACK_TOKEN: 'rotated-secret' });
    for (const [file, bytes, options] of mocks.write.mock.calls) {
      expect(file).toMatch(/\/connections\/accounts\/[a-f0-9]{64}\/[a-f0-9-]+\.json$/);
      expect(bytes).not.toMatch(/alice-secret|bob-secret|rotated-secret/);
      expect(options).toEqual({ mode: 0o600, createOnly: true });
    }
  });

  it('rejects substituted account ciphertext and older generation bytes', () => {
    const a = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'one' });
    const b = storeLocalAccountMaterial({ ...alice, ownerRef: 'user:bob' }, { SLACK_TOKEN: 'two' });
    const c = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'three' });
    const [aPath, bPath, cPath] = [...mocks.files.keys()];
    mocks.files.set(bPath!, mocks.files.get(aPath!)!);
    expect(() => loadLocalAccountMaterial(b)).toThrow('Account or generation mismatch');
    mocks.files.set(cPath!, mocks.files.get(aPath!)!);
    expect(() => loadLocalAccountMaterial(c)).toThrow('Account or generation mismatch');
    expect(loadLocalAccountMaterial(a)).toEqual({ SLACK_TOKEN: 'one' });
  });

  it('fails closed for tampering, plaintext, unsupported envelope and missing exact generation', () => {
    const ref = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'one' });
    const file = [...mocks.files.keys()][0]!;
    const original = mocks.files.get(file)!;
    const raw = JSON.parse(original);
    mocks.files.set(
      file,
      JSON.stringify({ ...raw, ciphertext: Buffer.from('tampered').toString('base64') })
    );
    expect(() => loadLocalAccountMaterial(ref)).toThrow();
    mocks.files.set(file, JSON.stringify({ ...raw, version: 2 }));
    expect(() => loadLocalAccountMaterial(ref)).toThrow('unsupported envelope version');
    mocks.files.set(file, '{"SLACK_TOKEN":"plaintext"}');
    expect(() => loadLocalAccountMaterial(ref)).toThrow('Encrypted material required');
    mocks.files.delete(file);
    expect(() => loadLocalAccountMaterial(ref)).toThrow('ENOENT');
  });

  it('refuses tenant and plugin callers before any material I/O', () => {
    const ref = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'one' });
    mocks.write.mockClear();
    for (const kind of ['tenant', 'plugin']) {
      mocks.tenant = kind === 'tenant' ? 'acme' : undefined;
      mocks.plugin = kind === 'plugin' ? {} : undefined;
      expect(() => storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'two' })).toThrow(
        'Local operator storage only'
      );
      expect(() => loadLocalAccountMaterial(ref)).toThrow('Local operator storage only');
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('rejects ambiguous identities, traversal, missing material and malformed references', () => {
    for (const identity of [
      { ...alice, serviceId: '../slack' },
      { ...alice, bindingId: '' },
      { ...alice, ownerRef: '' },
      { ...alice, tenantSlug: 'acme' },
      { ...alice, ownerKind: 'organization' as const, tenantSlug: 'acme', ownerRef: 'other' },
    ])
      expect(() => storeLocalAccountMaterial(identity, { SLACK_TOKEN: 'one' })).toThrow(
        'Exact service, binding and owner'
      );
    expect(() => storeLocalAccountMaterial(alice, {})).toThrow('secret-reference');
    expect(() => storeLocalAccountMaterial(alice, { SLACK_TOKEN: '' })).toThrow('secret-reference');
    expect(() => loadLocalAccountMaterial({ ...alice, generation: '../other' })).toThrow(
      'Exact generation'
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
