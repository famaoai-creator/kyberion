import { afterEach, describe, expect, it } from 'vitest';
import {
  listPluginActuatorOperations,
  resetPluginActuatorOperationsForTests,
  resolveActuatorOperation,
  listRegisteredDomainOps,
} from './actuator-op-registry.js';
import {
  activatePluginContributions,
  listPluginFacets,
  listPluginPromptSections,
} from './plugin-contributions.js';
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
        { name: 'usage' as const, status: 'declared' as const, evidence: 'adapter boundary' },
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
});
