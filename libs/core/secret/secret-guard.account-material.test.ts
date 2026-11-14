import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tenant: undefined as string | undefined,
  personalClaim: undefined as object | undefined,
  plugin: undefined as object | undefined,
  write: vi.fn(),
  onRead: undefined as undefined | ((file: string) => void),
}));
vi.mock('../core.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../secure-io.js', () => ({
  withSensitivePathMediation: <T>(run: () => T) => run(),
  assertSafeRepositoryPath: (file: string) => file,
  safeExistsSync: (file: string) => mocks.files.has(file),
  safeReaddir: () => [],
  safeFsyncFile: vi.fn(),
  safeWriteFile: (file: string, data: string, options: unknown) => {
    mocks.write(file, data, options);
    mocks.files.set(file, data);
  },
}));
vi.mock('../foundation/json.js', () => ({
  readJson: (file: string) => {
    mocks.onRead?.(file);
    const data = mocks.files.get(file);
    if (!data) throw new Error('ENOENT');
    return JSON.parse(data);
  },
}));
vi.mock('../foundation/credential-binding.js', () => ({
  credentialExecutionIdentity: () => ({
    tenantSlug: mocks.tenant,
    personalClaim: mocks.personalClaim,
  }),
}));
vi.mock('../shell/sandbox-policy.js', () => ({
  getPluginExecutionContext: () => mocks.plugin,
}));
vi.mock('../governance/ledger.js', () => ({ ledger: { record: vi.fn() } }));
vi.mock('../path-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../path-resolver.js')>()),
  resolve: (file: string) => `/repo/${file}`,
}));

import {
  loadLocalAccountMaterial,
  storeLocalAccountMaterial,
  storeLocalAccountRegistration,
  loadLocalAccountRegistration,
  localAccountMaterialAccountId,
  loadAllocatedLocalAccountRegistration,
  loadAllocatedLocalAccountMaterial,
} from './secret-guard.js';
import {
  withAccountCredentialMaterialCapability,
  withCredentialMaterialCapability,
} from '../foundation/credential-material-capability.js';
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
  mocks.personalClaim = undefined;
  mocks.plugin = undefined;
  mocks.onRead = undefined;
  overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 7));
});
afterEach(() => overrideSecretEncryptionKeyForTests(null));

describe('internal local account material storage', () => {
  it('denies operator account reads and writes inside a personal claim', () => {
    const ref = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'operator-fixture' });
    mocks.write.mockClear();
    mocks.personalClaim = { ownerId: 'user:alice' };
    expect(() => loadLocalAccountMaterial(ref)).toThrow('ACCOUNT_MATERIAL_DENIED');
    expect(() => loadLocalAccountRegistration(alice)).toThrow('ACCOUNT_MATERIAL_DENIED');
    expect(() => storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'forbidden' })).toThrow(
      'ACCOUNT_MATERIAL_DENIED'
    );
    expect(() => storeLocalAccountRegistration(alice, { generation: ref.generation })).toThrow(
      'ACCOUNT_MATERIAL_DENIED'
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('reads only an allocated completed exact account while operator APIs remain denied', () => {
    const ref = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'allocated-fixture' });
    storeLocalAccountRegistration(alice, { generation: ref.generation });
    const id = localAccountMaterialAccountId(alice);
    mocks.tenant = 'acme';
    expect(() => loadAllocatedLocalAccountRegistration(alice)).toThrow('admission');
    expect(() =>
      withCredentialMaterialCapability('acme', 'knowledge/personal/connections/slack.json', () =>
        loadAllocatedLocalAccountRegistration(alice)
      )
    ).toThrow('admission');
    withAccountCredentialMaterialCapability('acme', id, null, () => {
      expect(loadAllocatedLocalAccountRegistration(alice).generation).toBe(ref.generation);
      expect(() => loadAllocatedLocalAccountMaterial(ref)).toThrow('admission');
      expect(() => loadLocalAccountRegistration(alice)).toThrow('Local operator');
    });
    withAccountCredentialMaterialCapability('acme', id, ref.generation, () => {
      expect(loadAllocatedLocalAccountMaterial(ref)).toEqual({ SLACK_TOKEN: 'allocated-fixture' });
      expect(() => loadLocalAccountMaterial(ref)).toThrow('Local operator');
      expect(() => storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'forbidden' })).toThrow(
        'Local operator'
      );
      expect(() => loadAllocatedLocalAccountMaterial({ ...ref, ownerRef: 'user:bob' })).toThrow(
        'admission'
      );
      mocks.tenant = 'other';
      expect(() => loadAllocatedLocalAccountMaterial(ref)).toThrow('admission');
    });
  });
  it('refuses incomplete registration and rotation during an allocated read', () => {
    const ref = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'fixture' });
    const next = storeLocalAccountMaterial(alice, { SLACK_TOKEN: 'fixture' });
    const id = localAccountMaterialAccountId(alice);
    storeLocalAccountRegistration(alice, {
      generation: ref.generation,
      pendingApprovalId: 'pending',
    });
    mocks.tenant = 'acme';
    expect(() =>
      withAccountCredentialMaterialCapability('acme', id, ref.generation, () =>
        loadAllocatedLocalAccountMaterial(ref)
      )
    ).toThrow('incomplete or changed');
    mocks.tenant = undefined;
    storeLocalAccountRegistration(alice, { generation: ref.generation });
    const oldRegistration = [...mocks.files.entries()].find(([file]) =>
      file.endsWith('/registration.json')
    )!;
    storeLocalAccountRegistration(alice, { generation: next.generation });
    const newBytes = mocks.files.get(oldRegistration[0])!;
    mocks.files.set(oldRegistration[0], oldRegistration[1]);
    mocks.tenant = 'acme';
    mocks.onRead = (file) => {
      if (file.endsWith(`/${ref.generation}.json`)) mocks.files.set(oldRegistration[0], newBytes);
    };
    expect(() =>
      withAccountCredentialMaterialCapability('acme', id, ref.generation, () =>
        loadAllocatedLocalAccountMaterial(ref)
      )
    ).toThrow('incomplete or changed');
  });
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
