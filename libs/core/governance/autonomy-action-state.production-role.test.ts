import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRole, withExecutionContext } from '../authority.js';
import { safeWriteFile, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { autonomyLearningCapability } from '../foundation/autonomy-learning-capability.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import {
  actionAutonomyStats,
  recordAutonomyExecution,
  recordAutonomyOutcome,
  sweepAutonomyActionStates,
  applyAutonomyOverride,
} from './autonomy-action-state.js';

describe('production tenant autonomy store role mediation', () => {
  let tenantSlug: string;
  beforeEach(() => {
    tenantSlug = `vitest-learning-${randomUUID().slice(0, 8)}`;
    // Exercise real permission floors, not the deliberately writable Vitest sandbox.
    vi.stubEnv('VITEST', '');
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeWriteFile(
          pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`),
          JSON.stringify({ tenant_slug: tenantSlug, status: 'active' })
        ),
      'ecosystem_architect'
    );
  });
  afterEach(() => {
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeRmSync(
          pathResolver.rootResolve(
            `active/shared/runtime/autonomy-learning/confidential/${tenantSlug}`
          ),
          { recursive: true, force: true }
        ),
      'ecosystem_architect',
      tenantSlug
    );
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeRmSync(pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`), {
          force: true,
        }),
      'ecosystem_architect'
    );
    vi.unstubAllEnvs();
  });
  it.each(['mission_controller', 'organization_operator', 'chronos_gateway'])(
    'persists actual tenant receipts under %s without elevating callbacks or caller',
    (role) => {
      const action = `role-proof-${randomUUID()}`;
      withExecutionContext(
        role,
        () => {
          const deps = {
            tenantSlug,
            now: () => {
              expect(resolveRole()).toBe(role);
              return new Date();
            },
          };
          for (let i = 0; i < 20; i++) {
            const receipt_id = `${action}:${i}`;
            recordAutonomyOutcome(
              { action_id: action, receipt_id, decision: 'approve', executed: false },
              deps
            );
            recordAutonomyExecution({ action_id: action, receipt_id, ok: true }, deps);
          }
          expect(actionAutonomyStats(action, deps).succeeded).toBe(20);
          expect(sweepAutonomyActionStates([action], deps).promoted).toContain(`${action}→auto`);
          expect(applyAutonomyOverride(action, 'approve', [], deps).decision).toBe('auto');
          expect(resolveRole()).toBe(role);
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}/unrelated.json`),
              '{}'
            )
          ).toThrow();
        },
        'worker',
        tenantSlug
      );
    }
  );

  it('refuses cross-tenant writes and keeps alternate-root IO under the caller', () => {
    withExecutionContext(
      'organization_operator',
      () => {
        expect(() =>
          recordAutonomyExecution(
            { action_id: 'never', receipt_id: randomUUID(), ok: true },
            { tenantSlug: 'other-tenant' }
          )
        ).toThrow('ROLE_TENANT_SCOPE_MISMATCH');
        expect(() =>
          recordAutonomyExecution(
            { action_id: 'never', receipt_id: randomUUID(), ok: true },
            {
              tenantSlug,
              rootDir: pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}`),
            }
          )
        ).toThrow();
      },
      'worker',
      tenantSlug
    );
  });

  it('the bounded role cannot mutate arbitrary tenant knowledge or another tenant', () => {
    expect(() =>
      withExecutionContext('autonomy_learning_store', () => undefined, 'worker', tenantSlug)
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    runInResourceAccessScope(autonomyLearningCapability(tenantSlug), () =>
      withExecutionContext(
        'autonomy_learning_store',
        () => {
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}/unrelated.json`),
              '{}'
            )
          ).toThrow();
          expect(() =>
            safeWriteFile(
              pathResolver.shared(
                'runtime/autonomy-learning/confidential/other-tenant/autonomy-outcomes.jsonl'
              ),
              '{}'
            )
          ).toThrow();
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(
                `knowledge/confidential/${tenantSlug}/autonomy-outcomes.jsonl`
              ),
              '{}'
            )
          ).toThrow('RESOURCE_SCOPE_DENIED');
        },
        'worker',
        tenantSlug
      )
    );
    expect(() =>
      runInResourceAccessScope(
        {
          tenantSlug,
          readExact: [`knowledge/confidential/${tenantSlug}/unrelated.json`],
          writeExact: [`knowledge/confidential/${tenantSlug}/unrelated.json`],
          mkdirExact: [],
        },
        () => withExecutionContext('autonomy_learning_store', () => undefined, 'worker', tenantSlug)
      )
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    vi.stubEnv('SYSTEM_ROLE', 'autonomy_learning_store');
    expect(() =>
      safeWriteFile(
        pathResolver.shared(
          `runtime/autonomy-learning/confidential/${tenantSlug}/autonomy-outcomes.jsonl`
        ),
        '{}'
      )
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    vi.unstubAllEnvs();
    vi.stubEnv('VITEST', '');
  });
});
