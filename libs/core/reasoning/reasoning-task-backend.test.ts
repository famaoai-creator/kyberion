import { withExecutionContext } from '../authority.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import * as scopeEnvelope from '../scope-envelope.js';
import { currentScope, resetCurrentScope } from '../scope-context.js';
import {
  resolveTaskCredential,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import {
  getReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
} from './reasoning-backend.js';
import {
  constructTaskReasoningBackend,
  type TaskReasoningConstruction,
} from './reasoning-task-backend.js';
import {
  resolveReasoningRouteCandidates,
  type ResolvedReasoningRoute,
} from './reasoning-route-resolver.js';
import { hasFixedReasoningBinding } from './reasoning-fixed-binding.js';

vi.mock('./reasoning-route-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reasoning-route-resolver.js')>()),
  resolveReasoningRouteCandidates: vi.fn(),
}));

const route = {
  role: 'implementer',
  mode: 'codex-cli',
  model: 'test-model',
  profileRef: 'test-route',
  parameters: { temperature: 0.2 },
  toolsEnabled: false,
  allowedTools: [],
  limits: { timeoutMs: 1000 },
  failover: { max_attempts: 1, max_in_place_retries: 0 },
} as unknown as ResolvedReasoningRoute;

afterEach(() => {
  resetReasoningBackend();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  resetCurrentScope();
});

function construction() {
  const buildBundle = vi.fn<TaskReasoningConstruction['buildBundle']>(() => ({
    mode: 'codex-cli' as const,
    backend: {
      backend: {
        ...getReasoningBackend(),
        name: 'task-local',
        getNativeSubagentAdopter: () => null,
      },
    },
  }));
  return {
    buildBundle,
    filterChain: (chain: Parameters<TaskReasoningConstruction['filterChain']>[0]) => chain,
  };
}

describe('task-local reasoning construction', () => {
  it('requires trusted task credentials before resolving routes or constructing a provider', () => {
    const ports = construction();
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () => {
      expect(() => constructTaskReasoningBackend({}, ports)).toThrow(
        '[CREDENTIAL_BINDING_REQUIRED]'
      );
    });
    expect(ports.buildBundle).not.toHaveBeenCalled();
    expect(resolveReasoningRouteCandidates).not.toHaveBeenCalled();
  });

  it('constructs after binding, preserves explicit routing and does not replace the host singleton', () => {
    vi.mocked(resolveReasoningRouteCandidates).mockReturnValue([route]);
    const host = { ...getReasoningBackend(), name: 'host-sentinel' };
    registerReasoningBackend(host);
    const ports = construction();
    ports.buildBundle.mockImplementation(() => {
      expect(resolveTaskCredential('TEST_KEY')).toBe('bound-test-key');
      return {
        mode: 'codex-cli',
        backend: { backend: { ...host, name: 'task-local', getNativeSubagentAdopter: () => null } },
      };
    });
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { TEST_KEY: 'bound-test-key' } },
        () => {
          const backend = constructTaskReasoningBackend(
            { mode: 'codex-cli', model: 'test-model', role: 'implementer', profile: 'test-route' },
            ports
          );
          expect(backend.name).toBe('task-local');
          expect(getReasoningBackend()).toBe(host);
        }
      )
    );
    expect(resolveReasoningRouteCandidates).toHaveBeenCalledWith({
      role: 'implementer',
      requestedMode: 'codex-cli',
      requestedModel: 'test-model',
      requestedProfile: 'test-route',
      sampling: undefined,
      scope: expect.objectContaining({ tenant_slug: 'alpha' }),
    });
    expect(ports.buildBundle).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({ model: 'test-model', timeoutMs: 1000 })
    );
  });

  it('does not reuse task-local handles in a later execution identity', () => {
    vi.mocked(resolveReasoningRouteCandidates).mockReturnValue([route]);
    const ports = construction();
    const build = (tenantSlug: string) =>
      runInExecutionScope({ tenantBound: true, tenantSlug }, () =>
        withTaskCredentialBinding({ tenantSlug, secrets: {} }, () =>
          constructTaskReasoningBackend({}, ports)
        )
      );
    const first = build('alpha');
    const second = build('beta');
    expect(first).not.toBe(second);
    runInExecutionScope({ tenantBound: true, tenantSlug: 'beta' }, () =>
      expect(() => first.getNativeSubagentAdopter?.()).toThrow('[CREDENTIAL_OWNER_DENIED]')
    );
    expect(ports.buildBundle).toHaveBeenCalledTimes(2);
  });

  it('routes from the active task envelope instead of a cached ambient scope', () => {
    vi.mocked(resolveReasoningRouteCandidates).mockReturnValue([route]);
    vi.stubEnv('KYBERION_TENANT', undefined);
    vi.stubEnv('KYBERION_TIER', 'public');
    currentScope();
    const identity = {
      tenant_slug: 'alpha',
      tier: 'confidential' as const,
      mission_id: 'MSN-TASK-SCOPE',
      task_id: 'TASK-A',
    };
    vi.spyOn(scopeEnvelope, 'currentScopeEnvelope').mockReturnValue({
      identity,
      policy: { read_tiers: ['confidential'], write_tier: 'confidential', purpose: 'task' },
      minted_at: '2026-10-30T00:00:00.000Z',
      mint_ref: 'test-only',
    });
    withExecutionContext(
      'infrastructure_sentinel',
      () =>
        withTaskCredentialBinding(
          { tenantSlug: 'alpha', missionId: 'MSN-TASK-SCOPE', taskId: 'TASK-A', secrets: {} },
          () => constructTaskReasoningBackend({}, construction())
        ),
      undefined,
      'alpha',
      undefined,
      { missionId: 'MSN-TASK-SCOPE', taskId: 'TASK-A' }
    );
    expect(resolveReasoningRouteCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ scope: identity })
    );
  });

  it('keeps fixed binding metadata on the returned handle and disables unpinned native adoption', () => {
    const fixed = {
      ...route,
      selection: { requested: { mode: 'fixed' } },
    } as ResolvedReasoningRoute;
    vi.mocked(resolveReasoningRouteCandidates).mockReturnValue([fixed]);
    const backend = constructTaskReasoningBackend({}, construction());
    expect(hasFixedReasoningBinding(backend)).toBe(true);
    expect(backend.getNativeSubagentAdopter).toBeUndefined();
    expect(typeof backend.delegateTask).toBe('function');
    const ports = construction();
    ports.buildBundle.mockReturnValue({
      mode: 'codex-cli',
      backend: {
        backend: {
          ...getReasoningBackend(),
          name: 'native-required',
          requiresNativeSubagent: () => true,
        },
      },
    });
    const nativeRequired = constructTaskReasoningBackend({}, ports);
    expect(nativeRequired.getNativeSubagentAdopter).toBeUndefined();
    expect(nativeRequired.requiresNativeSubagent?.()).toBe(true);
  });

  it('refuses implicit stubs and fixed routes without an available backend', () => {
    const ports = construction();
    vi.mocked(resolveReasoningRouteCandidates).mockReturnValue([{ ...route, mode: 'stub' }]);
    expect(() => constructTaskReasoningBackend({}, ports)).toThrow(
      'implicit stub execution is disabled'
    );
    expect(ports.buildBundle).not.toHaveBeenCalled();
    vi.mocked(resolveReasoningRouteCandidates).mockReturnValue([
      { ...route, selection: { requested: { mode: 'fixed' } } } as ResolvedReasoningRoute,
    ]);
    ports.buildBundle.mockReturnValue(null as never);
    expect(() => constructTaskReasoningBackend({}, ports)).toThrow(
      'Fixed task backend could not be constructed'
    );
  });
});
