import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { policyEngine } from '../governance/policy-engine.js';
import { pathResolver } from '../path-resolver.js';
import { inspectReadPermission, validateWritePermission } from '../tier-guard.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import {
  ENGINE_RUNTIME_OPERATOR_ROLE,
  withEngineRuntimePreferencesAccess,
} from './engine-runtime-preferences-access.js';
const relative = 'knowledge/personal/onboarding/engine-runtime.json';
const file = pathResolver.rootResolve(relative);
beforeEach(() => {
  vi.stubEnv('KYBERION_SUDO', '');
  vi.stubEnv('MISSION_ROLE', '');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
});
afterEach(() => vi.unstubAllEnvs());
describe('operator exact role boundary', () => {
  it('does not grant the role alone any preference contents', () =>
    withExecutionContext(ENGINE_RUNTIME_OPERATOR_ROLE, () => {
      expect(inspectReadPermission(file).allowed).toBe(false);
      expect(validateWritePermission(file).allowed).toBe(false);
    }));
  it('grants the bound file to an ordinary worker while denying siblings and descendants', () =>
    withEngineRuntimePreferencesAccess(relative, () =>
      withExecutionContext(ENGINE_RUNTIME_OPERATOR_ROLE, () => {
        expect(inspectReadPermission(file).allowed).toBe(true);
        expect(validateWritePermission(file).allowed).toBe(true);
        for (const other of [
          relative + '/child',
          'knowledge/personal/onboarding/voice.json',
          'customer/other/onboarding/engine-runtime.json',
        ]) {
          expect(inspectReadPermission(pathResolver.rootResolve(other)).allowed).toBe(false);
          expect(validateWritePermission(pathResolver.rootResolve(other)).allowed).toBe(false);
        }
        expect(inspectReadPermission(pathResolver.knowledge('personal/onboarding')).allowed).toBe(
          false
        );
      })
    ));
  it('preserves an outer resource refusal ahead of the operator capability', () =>
    runInResourceAccessScope(
      { tenantSlug: 'engine-fixture', readExact: [], writeExact: [], mkdirExact: [] },
      () =>
        withEngineRuntimePreferencesAccess(relative, () =>
          withExecutionContext(ENGINE_RUNTIME_OPERATOR_ROLE, () => {
            expect(inspectReadPermission(file).reason).toContain('RESOURCE_SCOPE');
            expect(validateWritePermission(file).reason).toContain('RESOURCE_SCOPE');
          })
        )
    ));
  it('preserves the ceiling through nested system/architect assumptions', () =>
    withEngineRuntimePreferencesAccess(relative, () =>
      withExecutionContext(ENGINE_RUNTIME_OPERATOR_ROLE, () =>
        withExecutionContext('ecosystem_architect', () => {
          expect(
            inspectReadPermission(pathResolver.knowledge('personal/onboarding/voice.json')).allowed
          ).toBe(false);
          expect(
            validateWritePermission(pathResolver.rootResolve('active/shared/runtime/locks/other'))
              .allowed
          ).toBe(false);
        })
      )
    ));
  it('loads the actual cold write policy under the exact capability without private writes', () => {
    try {
      withEngineRuntimePreferencesAccess(relative, () =>
        withExecutionContext(ENGINE_RUNTIME_OPERATOR_ROLE, () => {
          policyEngine.loadFromFile();
          expect(policyEngine.getPolicyCounts().loaded).toBeGreaterThan(0);
          expect(
            policyEngine.evaluate({
              agentId: 'operator',
              operation: 'file_write',
              target_tier: 'personal',
              agent_tier: 'sovereign',
            }).allowed
          ).toBe(true);
          expect(
            inspectReadPermission(pathResolver.knowledge('product/governance/agent-policies.yaml'))
              .allowed
          ).toBe(true);
          expect(
            inspectReadPermission(pathResolver.knowledge('product/governance/other-policies.yaml'))
              .allowed
          ).toBe(false);
        })
      );
    } finally {
      policyEngine.loadFromFile();
    }
  });
});
