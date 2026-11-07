/**
 * System / person custody attestation store (INFORMATION_ASSET_SCOPE P1):
 * placement, validation (a `none` claim needs its approval basis), the
 * policy TTL, and the governed reader refusing tenant-scoped callers.
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../daemon/ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  CUSTODY_PROVIDER_ATTESTATION_ROOT,
  custodyProviderAttestationRelativePath,
  personCustodyOwnerKey,
  readCustodyProviderAttestationEntry,
  writeCustodyProviderAttestationEntry,
  type CustodyProviderAttestationEntry,
} from './custody-provider-attestation-store.js';
import {
  _resetProviderEgressPolicyCacheForTests,
  evaluateProviderEgress,
  lookupCustodyProviderAttestation,
} from './provider-egress-gate.js';

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const validNone = (overrides: Partial<CustodyProviderAttestationEntry> = {}) => ({
  training_use: 'none' as const,
  plan: 'Claude Team',
  basis: 'https://www.anthropic.com/legal/commercial-terms',
  attested_by: 'human:owner',
  attested_at: daysFromNow(-1),
  approval: { request_id: 'req-1', approved_by: 'human-owner' },
  ...overrides,
});

const asOperator = <T>(fn: () => T): T => withExecutionContext('sovereign_concierge', fn);

function clearStore(): void {
  asOperator(() =>
    safeRmSync(pathResolver.rootResolve(CUSTODY_PROVIDER_ATTESTATION_ROOT), {
      recursive: true,
      force: true,
    })
  );
}

describe('custody provider attestation store', () => {
  beforeEach(() => {
    clearStore();
    _resetProviderEgressPolicyCacheForTests();
  });
  afterEach(clearStore);

  it('places system custody in the system partition and person custody on the personal floor', () => {
    expect(custodyProviderAttestationRelativePath({ kind: 'system' })).toBe(
      'active/shared/runtime/provider-attestations/system/attestations.json'
    );
    expect(custodyProviderAttestationRelativePath({ kind: 'person' })).toBe(
      'active/shared/runtime/provider-attestations/personal/shared/operator.json'
    );
    const alice = custodyProviderAttestationRelativePath({ kind: 'person', principal_id: 'alice' });
    expect(alice).toMatch(
      /^active\/shared\/runtime\/provider-attestations\/personal\/shared\/principal-[0-9a-f]{32}\.json$/
    );
    // The principal id itself never appears in the path.
    expect(alice).not.toContain('alice');
    expect(personCustodyOwnerKey('alice')).not.toBe(personCustodyOwnerKey('bob'));
  });

  it('round-trips a valid entry per owner and keeps owners apart', () => {
    asOperator(() => {
      writeCustodyProviderAttestationEntry({ kind: 'system' }, 'claude', validNone());
      writeCustodyProviderAttestationEntry(
        { kind: 'person' },
        'codex',
        validNone({ training_use: 'used', approval: undefined })
      );
    });
    expect(readCustodyProviderAttestationEntry({ kind: 'system' }, 'claude').entry).toMatchObject({
      training_use: 'none',
    });
    expect(readCustodyProviderAttestationEntry({ kind: 'system' }, 'codex')).toEqual({});
    expect(readCustodyProviderAttestationEntry({ kind: 'person' }, 'claude')).toEqual({});
    expect(readCustodyProviderAttestationEntry({ kind: 'person' }, 'codex').entry).toMatchObject({
      training_use: 'used',
    });
    expect(
      readCustodyProviderAttestationEntry({ kind: 'person', principal_id: 'alice' }, 'codex')
    ).toEqual({});
  });

  it("refuses to write a 'none' claim without its approval basis or evidence", () => {
    expect(() =>
      asOperator(() =>
        writeCustodyProviderAttestationEntry(
          { kind: 'system' },
          'claude',
          validNone({ approval: undefined })
        )
      )
    ).toThrow(/requires an approval basis/);
    expect(() =>
      asOperator(() =>
        writeCustodyProviderAttestationEntry({ kind: 'system' }, 'claude', validNone({ plan: '' }))
      )
    ).toThrow(/requires plan/);
    expect(readCustodyProviderAttestationEntry({ kind: 'system' }, 'claude')).toEqual({});
  });

  it("treats a hand-placed 'none' without an approval basis as no attestation (fail closed)", () => {
    const file = pathResolver.rootResolve(
      custodyProviderAttestationRelativePath({ kind: 'system' })
    );
    asOperator(() => {
      safeMkdir(path.dirname(file), { recursive: true });
      safeWriteFile(
        file,
        JSON.stringify({
          version: 1,
          custody: { kind: 'system' },
          provider_attestations: { claude: validNone({ approval: undefined }) },
        })
      );
    });
    const read = readCustodyProviderAttestationEntry({ kind: 'system' }, 'claude');
    expect(read.entry).toBeUndefined();
    expect(read.error).toMatch(/requires an approval basis/);
    expect(
      lookupCustodyProviderAttestation({ custody: { kind: 'system' }, provider: 'claude' })
    ).toMatchObject({ status: 'absent' });
    expect(evaluateProviderEgress({ provider: 'claude', dataTier: 'confidential' }).allowed).toBe(
      false
    );
  });

  it('refuses a store file whose custody does not match its location', () => {
    const file = pathResolver.rootResolve(
      custodyProviderAttestationRelativePath({ kind: 'system' })
    );
    asOperator(() => {
      safeMkdir(path.dirname(file), { recursive: true });
      safeWriteFile(
        file,
        JSON.stringify({
          version: 1,
          custody: { kind: 'person' },
          provider_attestations: { claude: validNone() },
        })
      );
    });
    expect(readCustodyProviderAttestationEntry({ kind: 'system' }, 'claude').error).toMatch(
      /does not match its location/
    );
  });

  it('expires an entry without expires_at after the policy TTL (180 days)', () => {
    asOperator(() =>
      writeCustodyProviderAttestationEntry(
        { kind: 'system' },
        'claude',
        validNone({ attested_at: daysFromNow(-181) })
      )
    );
    expect(
      lookupCustodyProviderAttestation({ custody: { kind: 'system' }, provider: 'claude' })
    ).toMatchObject({ status: 'expired' });
    expect(evaluateProviderEgress({ provider: 'claude', dataTier: 'confidential' })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/attestation for the installation \(system custody\) expired/),
    });
    asOperator(() =>
      writeCustodyProviderAttestationEntry(
        { kind: 'system' },
        'claude',
        validNone({ attested_at: daysFromNow(-179) })
      )
    );
    expect(evaluateProviderEgress({ provider: 'claude', dataTier: 'confidential' })).toEqual({
      allowed: true,
      basis: 'system-attestation',
    });
  });

  it('does not let a tenant-scoped caller read or write the system or person store', () => {
    asOperator(() => {
      writeCustodyProviderAttestationEntry({ kind: 'system' }, 'claude', validNone());
      writeCustodyProviderAttestationEntry({ kind: 'person' }, 'claude', validNone());
    });
    const asTenant = <T>(fn: () => T): T =>
      withExecutionContext('mission_controller', fn, undefined, 'acme');
    for (const owner of [{ kind: 'system' as const }, { kind: 'person' as const }]) {
      const read = asTenant(() => readCustodyProviderAttestationEntry(owner, 'claude'));
      expect(read.entry).toBeUndefined();
      expect(read.error).toMatch(/not readable from the active tenant scope 'acme'/);
      expect(() =>
        asTenant(() => writeCustodyProviderAttestationEntry(owner, 'claude', validNone()))
      ).toThrow(/not readable from the active tenant scope 'acme'/);
    }
    // A tenant-bound delegation decides tenant custody, never the installation's statement.
    expect(
      asTenant(() => evaluateProviderEgress({ provider: 'claude', dataTier: 'confidential' }))
        .allowed
    ).toBe(false);
  });
});
