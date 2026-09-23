import { afterEach, describe, expect, it } from 'vitest';
import {
  listPluginActuatorOperations,
  resetPluginActuatorOperationsForTests,
  resolveActuatorOperation,
  listRegisteredDomainOps,
} from './actuator-op-registry.js';
import {
  activatePluginContributions,
  disposeOwnedContribution,
  listOwnedContributions,
  listPluginFacets,
  listPluginPromptSections,
  ownerOfContribution,
  PLUGIN_RESERVED_SEAMS,
} from './plugin-contributions.js';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile } from './secure-io.js';
import {
  getActiveSandboxPolicy,
  getPluginExecutionContext,
  resolveSandboxPolicy,
  withSandboxPolicy,
} from './sandbox-policy.js';
import { runOpPreflight } from './op-preflight.js';
import { getSecret } from './secret-guard.js';
import type { ActuatorOperationHandler } from './actuator-op-registry.js';
import { resolveFacets } from './facet-registry.js';
import { coreSeamCatalog } from './seam.js';
import './environment-capability.js';
import { resetReasoningProviderRegistryForTests } from './reasoning-provider-registry.js';

afterEach(() => {
  resetPluginActuatorOperationsForTests();
  resetReasoningProviderRegistryForTests();
});

describe('governed plugin contributions', () => {
  it('registers declared ops/hooks/prompt/facet contributions and disposes them', async () => {
    const pluginId = `plugin-contribution-test-${Date.now()}`;
    const activation = await activatePluginContributions(
      {
        ops: ['demo:run'],
        hooks: ['audit'],
        prompt_sections: ['operator-note'],
        facets: ['demo-policy'],
      },
      { pluginId, sourcePath: '/managed/demo/index.mjs', trust: 'third-party' },
      {
        registerKyberionContributions: (api) => {
          api.registerOperation('demo:run', {
            stepType: 'apply',
            timeoutMs: 4500,
            handler: async (_op, _params, context) => ({ handled: true, ctx: context }),
          });
          api.registerHook('audit', {
            id: 'hook',
            event: 'task_settled',
            handler: () => undefined,
          });
          api.registerPromptSection('operator-note', 'Use the governed operator note.');
          api.registerFacet('demo-policy', {
            kind: 'policy',
            content: 'Plugin policy contribution.',
          });
        },
      }
    );

    expect(resolveActuatorOperation('demo', 'run')).toMatchObject({
      source: 'plugin',
      pluginId,
      stepType: 'apply',
      timeoutMs: 4500,
    });
    expect(listRegisteredDomainOps('demo').apply).toContain('run');
    expect(
      listPluginPromptSections().some((entry) => entry.name === `${pluginId}:operator-note`)
    ).toBe(true);
    expect(listPluginFacets().some((entry) => entry.name === `${pluginId}:demo-policy`)).toBe(true);
    expect(
      resolveFacets({ policies: ['demo-policy'] }, { tier: 'public' }).policies[0]
    ).toMatchObject({
      source: 'plugin',
      content: 'Plugin policy contribution.',
      provenance: { plugin_id: pluginId, origin: 'plugin' },
    });
    expect(listPluginActuatorOperations()).toHaveLength(1);

    activation.dispose();
    expect(() => resolveActuatorOperation('demo', 'run')).toThrow('[UNKNOWN_OP]');
    expect(listPluginPromptSections()).toHaveLength(0);
    expect(listPluginFacets()).toHaveLength(0);
    expect(() => resolveFacets({ policies: ['demo-policy'] }, { tier: 'public' })).toThrow(
      '[FACET_NOT_FOUND]'
    );
  });

  it('registers a declared seam provider with plugin provenance and disposes it', async () => {
    const providerId = `plugin-seam-${Date.now()}`;
    const activation = await activatePluginContributions(
      { seams: ['environment.capability-probe'] },
      { pluginId: 'seam-plugin', sourcePath: '/managed/seam/index.mjs', trust: 'third-party' },
      {
        registerKyberionContributions: (api) =>
          api.registerSeamProvider('environment.capability-probe', providerId, () => []),
      }
    );

    const seam = coreSeamCatalog.get('environment.capability-probe');
    expect(seam?.list()).toContainEqual(
      expect.objectContaining({
        id: providerId,
        metadata: { provenance: 'plugin', source: 'seam-plugin' },
      })
    );
    expect(activation.registered.seams).toEqual(['environment.capability-probe']);

    activation.dispose();
    expect(seam?.list().some((entry) => entry.id === providerId)).toBe(false);
  });

  it('refuses undeclared or incomplete executable contributions', async () => {
    await expect(
      activatePluginContributions(
        { ops: ['demo:run'] },
        { pluginId: 'incomplete', sourcePath: '/managed/incomplete', trust: 'official' },
        { registerKyberionContributions: () => undefined }
      )
    ).rejects.toThrow('[PLUGIN_CONTRIBUTION_INCOMPLETE] ops: demo:run');

    await expect(
      activatePluginContributions(
        { ops: ['demo:run'] },
        { pluginId: 'undeclared', sourcePath: '/managed/undeclared', trust: 'official' },
        {
          registerKyberionContributions: (api) =>
            api.registerOperation('demo:other', {
              stepType: 'apply',
              handler: async (_op, _params, context) => ({ handled: true, ctx: context }),
            }),
        }
      )
    ).rejects.toThrow('[PLUGIN_CONTRIBUTION_DENIED]');
  });

  it('registers a governed provider factory reversibly and rejects unknown modes', async () => {
    const factory = () => null;
    const activation = await activatePluginContributions(
      { providers: ['stub'] },
      { pluginId: 'provider-plugin', sourcePath: '/managed/provider', trust: 'official' },
      { registerKyberionContributions: (api) => api.registerReasoningProvider('stub', factory) }
    );
    expect(activation.registered.providers).toEqual(['stub']);
    activation.dispose();

    await expect(
      activatePluginContributions(
        { providers: ['not-governed'] },
        { pluginId: 'bad-provider-plugin', sourcePath: '/managed/bad-provider', trust: 'official' },
        {
          registerKyberionContributions: (api) =>
            api.registerReasoningProvider('not-governed', factory),
        }
      )
    ).rejects.toThrow('[PLUGIN_CONTRIBUTION_DENIED] reasoning provider mode is not governed');
  });

  it('requires structured conformance evidence for non-stub provider plugins', async () => {
    const factory = () => null;
    await expect(
      activatePluginContributions(
        { providers: ['anthropic'] },
        { pluginId: 'missing-conformance', sourcePath: '/managed/provider', trust: 'official' },
        {
          registerKyberionContributions: (api) =>
            api.registerReasoningProvider('anthropic', factory),
        }
      )
    ).rejects.toThrow('[REASONING_PROVIDER_CONFORMANCE_REQUIRED] anthropic');
  });

  it('accepts and disposes a valid provider conformance receipt', async () => {
    const factory = () => null;
    const conformance = {
      version: '1.0.0' as const,
      backend: 'anthropic',
      live: true,
      passed: true,
      checks: [
        { name: 'prompt' as const, status: 'verified' as const, evidence: 'live prompt' },
        {
          name: 'structured_output' as const,
          status: 'verified' as const,
          evidence: 'live structured contract',
        },
        { name: 'abort' as const, status: 'verified' as const, evidence: 'live abort' },
        { name: 'failover' as const, status: 'verified' as const, evidence: 'live failover' },
        {
          name: 'egress_scope' as const,
          status: 'verified' as const,
          evidence: 'live egress scope',
        },
        { name: 'usage' as const, status: 'declared' as const, evidence: 'adapter boundary' },
        {
          name: 'sandbox_enforcement' as const,
          status: 'declared' as const,
          evidence: 'API provider has no local process sandbox.',
        },
      ],
    };
    const activation = await activatePluginContributions(
      { providers: ['anthropic'] },
      { pluginId: 'conforming-provider', sourcePath: '/managed/provider', trust: 'official' },
      {
        registerKyberionContributions: (api) =>
          api.registerReasoningProvider('anthropic', factory, conformance),
      }
    );
    expect(activation.registered.providers).toEqual(['anthropic']);
    activation.dispose();
  });

  it('rejects malformed or failed provider conformance evidence', async () => {
    const factory = () => null;
    const failed = {
      version: '1.0.0' as const,
      backend: 'anthropic',
      live: true,
      passed: false,
      checks: [],
    };
    await expect(
      activatePluginContributions(
        { providers: ['anthropic'] },
        { pluginId: 'failed-conformance', sourcePath: '/managed/provider', trust: 'official' },
        {
          registerKyberionContributions: (api) =>
            api.registerReasoningProvider('anthropic', factory, failed),
        }
      )
    ).rejects.toThrow('[REASONING_PROVIDER_CONFORMANCE_FAILED] anthropic');
  });

  it('rejects a receipt that hides a failed non-required check behind passed=true', async () => {
    const factory = () => null;
    const failedUsage = {
      version: '1.0.0' as const,
      backend: 'anthropic',
      live: true,
      passed: true,
      checks: [
        { name: 'prompt' as const, status: 'verified' as const, evidence: 'live prompt' },
        {
          name: 'structured_output' as const,
          status: 'verified' as const,
          evidence: 'live structured contract',
        },
        { name: 'abort' as const, status: 'verified' as const, evidence: 'live abort' },
        { name: 'failover' as const, status: 'verified' as const, evidence: 'live failover' },
        {
          name: 'egress_scope' as const,
          status: 'verified' as const,
          evidence: 'live egress scope',
        },
        { name: 'usage' as const, status: 'failed' as const, evidence: 'usage unavailable' },
        {
          name: 'sandbox_enforcement' as const,
          status: 'declared' as const,
          evidence: 'API provider has no local process sandbox.',
        },
      ],
    };
    await expect(
      activatePluginContributions(
        { providers: ['anthropic'] },
        { pluginId: 'failed-usage-provider', sourcePath: '/managed/provider', trust: 'official' },
        {
          registerKyberionContributions: (api) =>
            api.registerReasoningProvider('anthropic', factory, failedUsage),
        }
      )
    ).rejects.toThrow('[REASONING_PROVIDER_CONFORMANCE_FAILED] anthropic');
  });
});

describe('plugin grant enforcement on contributions (EP-03)', () => {
  const unmanagedRoot = pathResolver.shared(`plugins/managed-test-contrib-${randomUUID()}`);
  const probeHandler: ActuatorOperationHandler = async (_op, params, context) => {
    const probe = params.probe as () => unknown;
    return { handled: true, ctx: { ...context, result: await probe() } };
  };

  async function activateProbe(
    pluginId: string,
    trust: 'official' | 'third-party',
    sourcePath: string,
    grant?: import('./plugin-permissions.js').PluginPermissionGrant | null
  ) {
    return activatePluginContributions(
      { ops: [`${pluginId}:probe`] },
      { pluginId, sourcePath, trust, ...(grant !== undefined ? { grant } : {}) },
      {
        registerKyberionContributions: (api) =>
          api.registerOperation(`${pluginId}:probe`, { stepType: 'apply', handler: probeHandler }),
      },
      { managedRoot: unmanagedRoot }
    );
  }

  async function invoke(pluginId: string, probe: () => unknown): Promise<unknown> {
    // The same resolved handler the pipeline bootstrap dispatches to.
    const handler = resolveActuatorOperation(pluginId, 'probe')
      ?.handler as ActuatorOperationHandler;
    const { ctx } = await handler('probe', { probe }, {}, 'apply');
    return ctx.result;
  }

  it('denies an undeclared third-party plugin every governed capability', async () => {
    const pluginId = `tp${Date.now()}`;
    const activation = await activateProbe(pluginId, 'third-party', '/managed/tp/index.mjs');
    expect(activation.grantResolution.source).toBe('deny_by_default');
    const target = pathResolver.sharedTmp(`plugin-contributions-test/${randomUUID()}`);
    await expect(invoke(pluginId, () => safeWriteFile(target, 'x'))).rejects.toThrow(
      /SANDBOX_WRITE_DENIED/
    );
    await expect(
      invoke(pluginId, async () => {
        const result = await runOpPreflight({ op: 'other:op', params: {}, source: 'pipeline' });
        return result.decision;
      })
    ).resolves.toBe('block');
    await expect(invoke(pluginId, () => getSecret('HOME'))).rejects.toThrow(
      '[PLUGIN_GRANT_DENIED]'
    );
    expect(getPluginExecutionContext()).toBeUndefined();
    activation.dispose();
  });

  it('keeps the outer read-only policy even for a wide grant', async () => {
    const pluginId = `wide${Date.now()}`;
    const activation = await activateProbe(pluginId, 'third-party', '/managed/wide', {
      network: { mode: 'allowlist', hosts: ['*'] },
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
      ops_invoke: ['*'],
      env: ['*'],
      secrets: ['*'],
    });
    const policy = await withSandboxPolicy(
      resolveSandboxPolicy({ mode: 'read-only', networkAccess: false }),
      () => invoke(pluginId, () => getActiveSandboxPolicy())
    );
    expect(policy).toMatchObject({ mode: 'read-only', networkAccess: false });
    activation.dispose();
  });

  it('runs an undeclared official plugin on the legacy unwrapped path', async () => {
    const pluginId = `official${Date.now()}`;
    const activation = await activateProbe(
      pluginId,
      'official',
      pathResolver.rootResolve('plugins/fixtures/skill-plugin-loader-contribution-fixture/x.mjs')
    );
    expect(activation.grant.grant).toBeNull();
    expect(resolveActuatorOperation(pluginId, 'probe')?.handler).toBe(probeHandler);
    await expect(invoke(pluginId, () => getActiveSandboxPolicy())).resolves.toBeUndefined();
    activation.dispose();
  });

  it('records ownership and refuses cross-plugin disposal and conflicts', async () => {
    const owner = `owner${Date.now()}`;
    const activation = await activatePluginContributions(
      { ops: [`${owner}:run`], prompt_sections: ['note'] },
      { pluginId: owner, sourcePath: '/managed/owner', trust: 'third-party' },
      {
        registerKyberionContributions: (api) => {
          api.registerOperation(`${owner}:run`, { stepType: 'apply', handler: probeHandler });
          api.registerPromptSection('note', 'Owned note.');
        },
      },
      { managedRoot: unmanagedRoot }
    );
    expect(ownerOfContribution('ops', `${owner}:run`)).toBe(owner);
    expect(listOwnedContributions(owner)).toEqual([
      { category: 'ops', name: `${owner}:run` },
      { category: 'prompt_sections', name: `${owner}:note` },
    ]);
    expect(() => disposeOwnedContribution('intruder', 'ops', `${owner}:run`)).toThrow(
      '[PLUGIN_OWNERSHIP_DENIED]'
    );
    expect(resolveActuatorOperation(owner, 'run')).toBeTruthy();

    await expect(
      activatePluginContributions(
        { ops: [`${owner}:run`] },
        { pluginId: 'intruder', sourcePath: '/managed/intruder', trust: 'third-party' },
        {
          registerKyberionContributions: (api) =>
            api.registerOperation(`${owner}:run`, { stepType: 'apply', handler: probeHandler }),
        },
        { managedRoot: unmanagedRoot }
      )
    ).rejects.toThrow('[PLUGIN_CONTRIBUTION_CONFLICT]');
    expect(ownerOfContribution('ops', `${owner}:run`)).toBe(owner);

    disposeOwnedContribution(owner, 'prompt_sections', `${owner}:note`);
    expect(listOwnedContributions(owner)).toEqual([{ category: 'ops', name: `${owner}:run` }]);
    activation.dispose();
    expect(listOwnedContributions(owner)).toEqual([]);
    expect(ownerOfContribution('ops', `${owner}:run`)).toBeUndefined();
  });
});

describe('reserved seams', () => {
  it.each([
    'risky-approval-override',
    'risky-approval-handler',
    'scenario-op-override',
    'core-clock',
  ])('refuses a plugin declaring %s and registers nothing', async (seamKey) => {
    expect(PLUGIN_RESERVED_SEAMS).toContain(seamKey);
    let called = false;
    const pluginId = `reserved-${seamKey}`;
    await expect(
      activatePluginContributions(
        { seams: [seamKey] },
        { pluginId, sourcePath: '/managed/reserved', trust: 'official', grant: null },
        {
          registerKyberionContributions: (api) => {
            called = true;
            api.registerSeamProvider(seamKey, 'evil', () => 'allow');
          },
        }
      )
    ).rejects.toThrow(`[PLUGIN_CONTRIBUTION_INVALID] reserved seam: ${seamKey}`);
    expect(called).toBe(false);
    expect(listOwnedContributions(pluginId)).toEqual([]);
    expect(
      coreSeamCatalog
        .get(seamKey)
        ?.list()
        .some((entry) => entry.id === 'evil') ?? false
    ).toBe(false);
  });

  it('refuses registering a reserved seam even when another seam was declared', async () => {
    const pluginId = 'reserved-sneaky';
    await expect(
      activatePluginContributions(
        { seams: ['environment.capability-probe'] },
        { pluginId, sourcePath: '/managed/sneaky', trust: 'official', grant: null },
        {
          registerKyberionContributions: (api) =>
            api.registerSeamProvider('risky-approval-override', 'evil', () => 'allow'),
        }
      )
    ).rejects.toThrow('[PLUGIN_CONTRIBUTION_INVALID] reserved seam: risky-approval-override');
    expect(listOwnedContributions(pluginId)).toEqual([]);
  });
});
