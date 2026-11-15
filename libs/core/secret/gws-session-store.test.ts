import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tenant: undefined as string | undefined,
  personalClaim: undefined as object | undefined,
  plugin: undefined as object | undefined,
  role: 'sovereign_concierge',
  writeFailure: false,
  writes: vi.fn(),
  locks: vi.fn(),
  keychain: vi.fn(),
}));
vi.mock('../platform-facts.js', () => ({ isMacOS: () => true }));
vi.mock('../authority.js', () => ({ resolveAssumedRole: () => fixture.role }));
vi.mock('../foundation/credential-binding.js', () => ({
  credentialExecutionIdentity: () => ({
    tenantSlug: fixture.tenant,
    personalClaim: fixture.personalClaim,
  }),
}));
vi.mock('../shell/sandbox-policy.js', () => ({ getPluginExecutionContext: () => fixture.plugin }));
vi.mock('../path-resolver.js', () => ({
  pathResolver: { resolve: (path: string) => `/repo/${path}` },
}));
vi.mock('../foundation/lock-utils.js', () => ({
  withLockSync: <T>(name: string, run: () => T) => {
    fixture.locks(name);
    return run();
  },
}));
// Synthetic IO only; the actual AES-GCM codec and existing-key path remain real.
vi.mock('../secure-io.js', () => ({
  safeExecResult: fixture.keychain,
  withSensitivePathMediation: <T>(run: () => T) => run(),
  assertSafeRepositoryPath: (path: string) => path,
  safeExistsSync: (path: string) => fixture.files.has(path),
  safeReadFile: (path: string) => fixture.files.get(path),
  safeWriteFile: (path: string, value: string, options: unknown) => {
    fixture.writes(path, value, options);
    if (fixture.writeFailure) throw new Error('synthetic secret-bearing IO error');
    fixture.files.set(path, value);
  },
}));
// Keep the real JSON facade, with bounded synthetic IO and the canonical parser.
vi.mock('../foundation/io.js', async () => {
  const { safeWriteFile } = await import('../secure-io.js');
  const { parseSafeJsonInput } = await import('../foundation/safe-json.js');
  return {
    getFoundationIo: () => ({
      writeFile: safeWriteFile,
      loadJson: (path: string, options: { maxSizeMB: number; label: string }) => {
        expect(options).toEqual({ maxSizeMB: 0.25, label: 'encrypted GWS session' });
        const text = fixture.files.get(path)!;
        if (Buffer.byteLength(text, 'utf8') > options.maxSizeMB * 1024 * 1024)
          throw new Error('synthetic oversized file');
        return parseSafeJsonInput(text, options.label);
      },
    }),
  };
});
import {
  overrideSecretEncryptionKeyForTests,
  decryptConnectionDocument,
} from './secret-encryption.js';
import { withGwsSessionRegistrationAdmission } from '../foundation/gws-session-registration-admission.js';
import {
  prepareGwsSessionRegistration,
  commitGwsSessionRegistration,
  abortGwsSessionRegistration,
  loadGwsSessionRegistration,
} from './gws-session-store.js';
import type { GwsSessionStageIdentity } from './gws-session-registration-contract.js';

const material = {
  type: 'authorized_user' as const,
  client_id: 'synthetic-client',
  client_secret: 'synthetic-private-secret',
  refresh_token: 'synthetic-refresh-token',
};
function stage(
  generation = '12345678-1234-4123-8123-123456789012',
  expected: string | null = null
): GwsSessionStageIdentity {
  return {
    version: 1,
    requestId: '12345678-1234-4123-8123-123456789010',
    target: {
      bindingId: 'acme-gws',
      serviceId: 'google-workspace',
      ownerKind: 'organization',
      ownerRef: 'acme',
      tenantSlug: 'acme',
      authMode: 'session',
      expectedGeneration: expected,
    },
    generation,
    requesterActorId: 'nhi:operator',
    approvalId: 'approval-1',
    bindingSnapshotDigest: 'a'.repeat(64),
    brokerConfigurationDigest: 'b'.repeat(64),
  };
}
const admitted = <T>(value: GwsSessionStageIdentity, run: () => T) =>
  withGwsSessionRegistrationAdmission(value, run);
beforeEach(() => {
  fixture.files.clear();
  fixture.tenant = undefined;
  fixture.personalClaim = undefined;
  fixture.plugin = undefined;
  fixture.role = 'sovereign_concierge';
  fixture.writeFailure = false;
  fixture.writes.mockClear();
  fixture.locks.mockClear();
  fixture.keychain.mockReset();
  fixture.keychain.mockReturnValue({ status: 44, stdout: '', stderr: 'synthetic missing key' });
  overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 19));
});
afterEach(() => overrideSecretEncryptionKeyForTests(null));

describe('encrypted GWS registration aggregate', () => {
  it('never creates a key when storing or reading without the existing key', async () => {
    const value = stage();
    await admitted(value, () => prepareGwsSessionRegistration(value, material));
    overrideSecretEncryptionKeyForTests(null);
    expect(() => loadGwsSessionRegistration(value.target)).toThrow('unavailable');
    const other = { ...stage(), target: { ...value.target, bindingId: 'other-gws' } };
    await expect(
      admitted(other, () => prepareGwsSessionRegistration(other, material))
    ).rejects.toThrow('unavailable');
    expect(fixture.keychain).toHaveBeenCalled();
    expect(fixture.keychain.mock.calls.every(([command]) => command === 'security')).toBe(true);
    expect(fixture.files.size).toBe(1);
  });
  it('persists encrypted pending state, promotes with revalidation, and returns metadata only', async () => {
    const value = stage();
    const revalidate = vi.fn();
    await admitted(value, () => prepareGwsSessionRegistration(value, material));
    expect(loadGwsSessionRegistration(value.target)).toMatchObject({
      generation: null,
      pendingStage: value,
    });
    expect(JSON.stringify([...fixture.files.values()])).not.toContain(material.refresh_token);
    expect(fixture.writes.mock.calls[0][0]).toMatch(
      /connections\/accounts\/[a-f0-9]{64}\/gws-session-registration.json$/
    );
    expect(fixture.writes.mock.calls[0][2]).toEqual({ mode: 0o600 });
    expect(
      await admitted(value, () => commitGwsSessionRegistration(value, revalidate))
    ).toMatchObject({ status: 'committed' });
    expect(revalidate).toHaveBeenCalledOnce();
    const result = loadGwsSessionRegistration({ ...value.target, expectedGeneration: null });
    expect(result.generation).toBe(value.generation);
    expect(result).not.toHaveProperty('pendingStage');
    expect(JSON.stringify(result)).not.toContain(material.client_secret);
    expect(fixture.files.size).toBe(1);
    expect(fixture.locks).toHaveBeenCalledWith(
      expect.stringMatching(/^gws-session-store:[a-f0-9]{64}$/)
    );
  });

  it('rejects missing, substituted and expired exact-object admission', async () => {
    const value = stage();
    expect(() => prepareGwsSessionRegistration(value, material)).toThrow(
      'registration_admission_required'
    );
    await expect(
      admitted(value, () => prepareGwsSessionRegistration({ ...value }, material))
    ).rejects.toThrow('registration_admission_required');
    let later!: () => void;
    await admitted(value, () => {
      later = () => prepareGwsSessionRegistration(value, material);
    });
    expect(later).toThrow('registration_admission_required');
    expect(fixture.files.size).toBe(0);
  });

  it.each(['tenant', 'personalClaim', 'plugin', 'role'] as const)(
    'refuses %s callers without filesystem access',
    async (field) => {
      const value = stage();
      if (field === 'tenant') fixture.tenant = 'acme';
      else if (field === 'role') fixture.role = 'worker';
      else fixture[field] = {};
      await expect(
        admitted(value, () => prepareGwsSessionRegistration(value, material))
      ).rejects.toThrow('operator_required');
      expect(() => loadGwsSessionRegistration(value.target)).toThrow('operator_required');
      expect(fixture.writes).not.toHaveBeenCalled();
    }
  );

  it('fences concurrent pending preparation and stale replacement; preserves committed material', async () => {
    const first = stage();
    const second = stage('12345678-1234-4123-8123-123456789013');
    await admitted(first, () => prepareGwsSessionRegistration(first, material));
    await expect(
      admitted(second, () => prepareGwsSessionRegistration(second, material))
    ).rejects.toThrow('recovery_required');
    await admitted(first, () => commitGwsSessionRegistration(first, () => {}));
    await expect(
      admitted(second, () => prepareGwsSessionRegistration(second, material))
    ).rejects.toThrow('generation_conflict');
    const replacement = stage(second.generation, first.generation);
    await admitted(replacement, () => prepareGwsSessionRegistration(replacement, material));
    await expect(admitted(first, () => abortGwsSessionRegistration(first))).rejects.toThrow(
      'already_committed'
    );
    await admitted(replacement, () => abortGwsSessionRegistration(replacement));
    await admitted(replacement, () => abortGwsSessionRegistration(replacement));
    expect(loadGwsSessionRegistration(first.target).generation).toBe(first.generation);
  });

  it('rejects another stage abort and commits with changed approval, actor or generation', async () => {
    const first = stage();
    await admitted(first, () => prepareGwsSessionRegistration(first, material));
    for (const changed of [
      { ...first, approvalId: 'approval-other' },
      { ...first, requesterActorId: 'nhi:other' },
      stage('12345678-1234-4123-8123-123456789013'),
    ]) {
      await expect(admitted(changed, () => abortGwsSessionRegistration(changed))).rejects.toThrow(
        'stage_changed'
      );
      await expect(
        admitted(changed, () => commitGwsSessionRegistration(changed, () => {}))
      ).rejects.toThrow('stage_changed');
    }
    expect(loadGwsSessionRegistration(first.target).generation).toBeNull();
  });

  it('keeps pending state if approval revalidation, synchronous contract or atomic write fails', async () => {
    const value = stage();
    await admitted(value, () => prepareGwsSessionRegistration(value, material));
    await expect(
      admitted(value, () =>
        commitGwsSessionRegistration(value, () => {
          throw new Error(material.client_secret);
        })
      )
    ).rejects.toThrow('[GWS_SESSION_STORE] unavailable');
    await expect(
      admitted(value, () => commitGwsSessionRegistration(value, (() => Promise.resolve()) as never))
    ).rejects.toThrow('synchronous_revalidation_required');
    fixture.writeFailure = true;
    await expect(
      admitted(value, () => commitGwsSessionRegistration(value, () => {}))
    ).rejects.toThrow('[GWS_SESSION_STORE] unavailable');
    fixture.writeFailure = false;
    expect(loadGwsSessionRegistration(value.target)).toMatchObject({
      generation: null,
      pendingStage: value,
    });
  });

  it('detects caller mutation during revalidation before publication', async () => {
    const value = stage();
    await admitted(value, () => prepareGwsSessionRegistration(value, material));
    await expect(
      admitted(value, () =>
        commitGwsSessionRegistration(value, () => {
          (value as { approvalId: string }).approvalId = 'changed';
        })
      )
    ).rejects.toThrow('stage_changed');
    expect(loadGwsSessionRegistration(value.target).generation).toBeNull();
  });

  it('refuses plaintext, tampered ciphertext and swapped account documents', async () => {
    const value = stage();
    await admitted(value, () => prepareGwsSessionRegistration(value, material));
    const [file, saved] = [...fixture.files.entries()][0];
    fixture.files.set(file, ' '.repeat(256 * 1024 + 1));
    expect(() => loadGwsSessionRegistration(value.target)).toThrow('unavailable');
    fixture.files.set(file, JSON.stringify({ material }));
    expect(() => loadGwsSessionRegistration(value.target)).toThrow('encrypted_record_required');
    const envelope = JSON.parse(saved);
    envelope.tag = Buffer.alloc(16).toString('base64');
    fixture.files.set(file, JSON.stringify(envelope));
    expect(() => loadGwsSessionRegistration(value.target)).toThrow('unavailable');
    fixture.files.set(file, saved);
    const other = { ...value.target, bindingId: 'other-gws' };
    const otherStage = { ...stage('12345678-1234-4123-8123-123456789013'), target: other };
    await admitted(otherStage, () => prepareGwsSessionRegistration(otherStage, material));
    const otherFile = [...fixture.files.keys()].find((key) => key !== file)!;
    fixture.files.set(otherFile, saved);
    expect(() => loadGwsSessionRegistration(other)).toThrow('identity_mismatch');
  });

  it('commits replacement as one encrypted aggregate and discards previous material', async () => {
    const first = stage();
    await admitted(first, () => {
      prepareGwsSessionRegistration(first, material);
      commitGwsSessionRegistration(first, () => {});
    });
    const next = stage('12345678-1234-4123-8123-123456789013', first.generation);
    await admitted(next, () => {
      prepareGwsSessionRegistration(next, { ...material, refresh_token: 'new-synthetic-refresh' });
      commitGwsSessionRegistration(next, () => {});
    });
    const envelope = JSON.parse([...fixture.files.values()][0]);
    const stored = decryptConnectionDocument(envelope);
    expect(stored.pending).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(material.refresh_token);
    expect(loadGwsSessionRegistration(first.target).generation).toBe(next.generation);
  });
});
