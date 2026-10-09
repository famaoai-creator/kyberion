import { describe, expect, it, vi } from 'vitest';
import { logger } from './core.js';
import { ensureAgentRuntime, registerAgentRuntimeEnsurer } from './agent/agent-runtime-port.js';
import { coreSeamCatalog } from './seam.js';
import {
  executeRegisteredSuperPipeline,
  registerSuperNerveExecutor,
} from './super-nerve-execution-port.js';
import {
  listDemotedProviders,
  registerHealthyInstancesResolver,
} from './provider/provider-health-view.js';
import {
  registerIdentityContextResolver,
  resolvePolicyIdentityContext,
} from './identity-context-bridge.js';
import {
  dispatchThroughMissionWorkerCore,
  registerMissionWorkerCoreDispatcher,
} from './mission/mission-orchestration-worker-dispatch-port.js';

describe('remaining sole seam ports', () => {
  it('registers and disposes the runtime ensurer seam', async () => {
    const handle = { getRecord: () => ({ agent_id: 'agent-1' }) } as never;
    const dispose = registerAgentRuntimeEnsurer(async () => handle);
    expect(coreSeamCatalog.get('agent-runtime-ensurer')?.list()).toHaveLength(1);
    await expect(ensureAgentRuntime({ agentId: 'agent-1' } as never)).resolves.toBe(handle);
    dispose();
    await expect(ensureAgentRuntime({ agentId: 'agent-1' } as never)).rejects.toThrow(
      'Agent runtime supervisor is not initialized'
    );
  });

  it('rejects a second Super-Nerve executor and restores the missing state on dispose', async () => {
    const first = async () => ({ ok: true });
    const second = async () => ({ ok: false });
    const dispose = registerSuperNerveExecutor(first);
    expect(() => registerSuperNerveExecutor(second)).toThrow(/already registered/);
    await expect(executeRegisteredSuperPipeline([])).resolves.toEqual({ ok: true });
    dispose();
    await expect(executeRegisteredSuperPipeline([])).rejects.toThrow(
      'Super-Nerve executor is not initialized'
    );
  });

  it('keeps the conservative provider-health fallback until a resolver is installed', () => {
    expect(listDemotedProviders([])).toEqual([]);
    const dispose = registerHealthyInstancesResolver(() => []);
    expect(listDemotedProviders([{ provider: 'test', installed: true } as never])).toEqual([
      'test',
    ]);
    dispose();
    expect(listDemotedProviders([{ provider: 'test', installed: true } as never])).toEqual([]);
  });

  it('keeps identity context bootstrap safe and rejects replacement', () => {
    const first = (tenantOverride?: string) => ({
      persona: 'worker' as const,
      executionMode: 'mission' as const,
      authorities: [],
      tenantSlug: tenantOverride,
    });
    const second = first;
    const dispose = registerIdentityContextResolver(first);
    expect(resolvePolicyIdentityContext('tenant-a').tenantSlug).toBe('tenant-a');
    expect(() => registerIdentityContextResolver(second)).toThrow(/already registered/);
    dispose();
    expect(resolvePolicyIdentityContext('tenant-b').tenantSlug).toBe('tenant-b');
  });

  it('registers and disposes the mission worker core dispatcher seam', async () => {
    const dispose = registerMissionWorkerCoreDispatcher(async (input) => ({ input }));
    await expect(dispatchThroughMissionWorkerCore('payload', {})).resolves.toEqual({
      input: 'payload',
    });
    dispose();
    await expect(dispatchThroughMissionWorkerCore('payload', {})).rejects.toThrow(
      'Mission worker core dispatcher is not initialized'
    );
  });

  it('lets the owner of a replace key supersede its stale registration, with a warning', async () => {
    // A module-registry reset racing an in-flight import evaluates
    // mission-orchestration-worker-part-core twice against one port instance;
    // the second module-level registration presents the same key and must not
    // throw SEAM_DUPLICATE_PROVIDER.
    const replaceKey = Symbol('test-owner');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const releaseStale = registerMissionWorkerCoreDispatcher(async () => 'stale', undefined, {
        replaceKey,
      });
      expect(warn).not.toHaveBeenCalled();
      const release = registerMissionWorkerCoreDispatcher(async () => 'fresh', undefined, {
        replaceKey,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /^\[MISSION_WORKER_CORE\] superseding .+ — .+ \| next: .+ \| evidence: seam=mission-worker-core-dispatcher/
      );
      await expect(dispatchThroughMissionWorkerCore('payload', {})).resolves.toBe('fresh');
      releaseStale(); // a no-op once superseded
      await expect(dispatchThroughMissionWorkerCore('payload', {})).resolves.toBe('fresh');
      release();
      await expect(dispatchThroughMissionWorkerCore('payload', {})).rejects.toThrow(
        'Mission worker core dispatcher is not initialized'
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('never lets a caller without the replace key evict a keyed registration', async () => {
    const release = registerMissionWorkerCoreDispatcher(async () => 'builtin', undefined, {
      replaceKey: Symbol('owner'),
    });
    try {
      expect(() => registerMissionWorkerCoreDispatcher(async () => 'intruder')).toThrow(
        /already registered/
      );
      expect(() =>
        registerMissionWorkerCoreDispatcher(async () => 'intruder', undefined, {
          replaceKey: Symbol('owner'), // same description, different key
        })
      ).toThrow(/already registered/);
      await expect(dispatchThroughMissionWorkerCore('payload', {})).resolves.toBe('builtin');
    } finally {
      release();
    }
  });

  it('keeps rejecting a keyed registration when another provider holds the seam', async () => {
    const dispose = registerMissionWorkerCoreDispatcher(async () => 'double');
    try {
      expect(() =>
        registerMissionWorkerCoreDispatcher(async () => 'builtin', undefined, {
          replaceKey: Symbol('owner'),
        })
      ).toThrow(/already registered/);
      await expect(dispatchThroughMissionWorkerCore('payload', {})).resolves.toBe('double');
    } finally {
      dispose();
    }
  });
});
