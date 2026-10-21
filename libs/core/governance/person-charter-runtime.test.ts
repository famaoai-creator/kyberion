import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { safeMkdir, safeWriteFile, safeCopyFileSync, safeRmSync } from '../secure-io.js';
const root = path.join(process.cwd(), 'active/shared/tmp/person-charter-runtime-' + randomUUID());
let registry: typeof import('./accountability-charter-registry.js');
let binding: typeof import('./person-charter-runtime.js');
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let store: typeof import('./external-operation-store.js');
const owner = { ownerActor: 'user:owner', agentId: 'kyberion://agent/local/installed-worker' };
beforeAll(async () => {
  withExecutionContext('ecosystem_architect', () => {
    safeMkdir(path.join(root, 'knowledge/product/governance'), { recursive: true });
    safeWriteFile(path.join(root, 'package.json'), '{}');
    for (const file of [
      'agent-policies.yaml',
      'security-policy.json',
      'role-assumption-policy.json',
      'authority-role-index.json',
      'knowledge-sync-rules.json',
    ])
      safeCopyFileSync(
        path.join(process.cwd(), 'knowledge/product/governance', file),
        path.join(root, 'knowledge/product/governance', file)
      );
  });
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('SYSTEM_ROLE', 'chronos_mirror_v2');
  vi.stubEnv('KYBERION_ALLOW_TEST_NOTIFICATIONS', '0');
  vi.resetModules();
  registry = await import('./accountability-charter-registry.js');
  binding = await import('./person-charter-runtime.js');
  authority = await import('../authority.js');
  io = await import('../secure-io.js');
  store = await import('./external-operation-store.js');
  authority.withExecutionContext('sovereign_concierge', () => {
    io.safeWriteFile(
      path.join(root, 'knowledge/personal/profile-sentinel.json'),
      'private-profile'
    );
    registry.acceptCharter({
      draft: {
        charter_id: 'chr-person-runtime',
        scope: { kind: 'person' },
        accountable: {
          actor: owner.ownerActor,
          authority_basis: { kind: 'owner', evidence_ref: 'verified-installed-profile' },
          expires_at: '2030-01-01T00:00:00Z',
          deputies: [],
        },
        envelope: {
          money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
          data_tier: { read: [], write: [] },
          external_effects: {},
          irreversible: 'forbid',
        },
        appetite: {
          max_loss_per_incident: 0,
          reputational_class_max: 'B',
          blast_radius_max: { recipients: 1, systems: 1 },
          tripwires: ['manual-stop'],
        },
      },
      statement: 'Installed owner fixture accepts',
      acceptedBy: { kind: 'human', id: owner.ownerActor },
      validation: { holder_role: 'owner' },
      now: new Date('2026-10-01'),
    });
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
  withExecutionContext('ecosystem_architect', () =>
    safeRmSync(root, { recursive: true, force: true })
  );
});
it('keeps the worker unprivileged while mediating only owned registry IO and canonical reservation', () => {
  authority.withExecutionContext('chronos_operator', () => {
    const privatePath = path.join(root, 'knowledge/personal/profile-sentinel.json');
    expect(() => io.safeReadFile(privatePath)).toThrow();
    expect(() =>
      authority.withExecutionContext('person_charter_store', () =>
        io.safeReadFile(path.join(root, 'knowledge/personal/charters/chr-person-runtime.json'))
      )
    ).toThrow();
    binding.withInstalledPersonCharterRuntime(owner, () => {
      expect(authority.resolveRole()).toBe('chronos_operator');
      const charter = registry.findActiveCharter({ kind: 'person' }, new Date())!;
      expect(charter.charter_id).toBe('chr-person-runtime');
      const action = {
        actor: { kind: 'agent' as const, id: owner.agentId, on_behalf_of: owner.ownerActor },
        action_class: 'internal_work',
        reversible: true,
      };
      const evaluated = registry.evaluateUnderCharter({ kind: 'person' }, action, {
        accountable_available: true,
        available_deputies: [],
      })!;
      expect(
        registry.recordCharterConsumption(
          charter,
          action,
          evaluated.decision,
          {},
          new Date(),
          'person-test-effect'
        )
      ).toBe(true);
      expect(registry.readCharterLedger(charter)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'consumption', correlation_id: 'person-test-effect' }),
        ])
      );
      expect(() =>
        store.reserveExternalOperation({
          operationId: 'test:public-effect',
          invocationId: 'owned-invocation',
          effectHash: 'a'.repeat(64),
        })
      ).not.toThrow();
      expect(() => io.safeReadFile(privatePath)).toThrow();
      expect(() =>
        authority.withExecutionContext('person_charter_store', () => io.safeReadFile(privatePath))
      ).toThrow();
      expect(() =>
        registry.clearTripwire(charter, 'manual-stop', { kind: 'human', id: owner.ownerActor })
      ).toThrow();
    });
    binding.withInstalledPersonCharterRuntime({ ...owner, ownerActor: 'user:other' }, () =>
      expect(() => registry.readCharter({ kind: 'person' }, 'chr-person-runtime')).toThrow(
        'PERSON_CHARTER_OWNER_MISMATCH'
      )
    );
  });
});
