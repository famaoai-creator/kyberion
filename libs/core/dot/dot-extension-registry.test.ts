import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotExtensionRegistration } from './dot-extension-registry.js';
import type { DotWakeTool } from './dot-extensions.js';

beforeEach(() => vi.resetModules());

const registration = (id: string, order = 0): DotExtensionRegistration => ({
  id,
  order,
  metadata: { provenance: 'plugin', source: `plugins/${id}` },
  hooks: { statusSections: [{ id, collect: () => ({}) }] },
});
const tool = (name: string, fence = name): DotWakeTool => ({
  name,
  fence,
  maxPerWake: 1,
  definition: { name, description: 'Test tool', inputSchema: { type: 'object' } },
  parse: (input) => ({ ok: true, value: input }),
  apply: () => [],
});

describe('dot extension registration', () => {
  it('orders hooks deterministically and reports defensive provenance snapshots', async () => {
    const registry = await import('./dot-extension-registry.js');
    registry.registerDotExtension(registration('later', 20));
    registry.registerDotExtension(registration('first', -10));
    registry.registerDotExtension(registration('tie', 20));
    expect(registry.DOT_STATUS_SECTIONS.map((section) => section.id)).toEqual([
      'first',
      'later',
      'tie',
    ]);
    const snapshot = registry.listDotExtensions();
    expect(snapshot.map((entry) => entry.id)).toEqual(['first', 'later', 'tie']);
    expect(snapshot[0].metadata).toEqual({ provenance: 'plugin', source: 'plugins/first' });
    snapshot[0].metadata.source = 'changed';
    expect(registry.listDotExtensions()[0].metadata.source).toBe('plugins/first');
  });

  it('unregisters only its own hooks and old disposers cannot remove replacements', async () => {
    const registry = await import('./dot-extension-registry.js');
    const remove = registry.registerDotExtension(registration('removable'));
    registry.registerDotExtension(registration('retained'));
    remove();
    remove();
    expect(registry.DOT_STATUS_SECTIONS.map((section) => section.id)).toEqual(['retained']);
    registry.registerDotExtension(registration('removable'));
    remove();
    expect(registry.listDotExtensions().map((entry) => entry.id)).toEqual([
      'retained',
      'removable',
    ]);
  });

  it.each([false, true])(
    'keeps shared hook ordering scoped to its seam after other seam unregister=%s',
    async (unregisterOtherSeam) => {
      const registry = await import('./dot-extension-registry.js');
      const shared = { id: 'shared', collect: () => ({}), lines: () => [] };
      registry.registerDotExtension({
        ...registration('status-owner', 10),
        hooks: { statusSections: [shared] },
      });
      const removeDigest = registry.registerDotExtension({
        ...registration('digest-owner', 100),
        hooks: { digestSections: [shared] },
      });
      if (unregisterOtherSeam) removeDigest();
      registry.registerDotExtension(registration('candidate', unregisterOtherSeam ? 5 : 20));
      expect(registry.DOT_STATUS_SECTIONS.map((hook) => hook.id)).toEqual(
        unregisterOtherSeam ? ['candidate', 'shared'] : ['shared', 'candidate']
      );
      expect(registry.DOT_DIGEST_SECTIONS).toEqual(unregisterOtherSeam ? [] : [shared]);
    }
  );

  it('rejects duplicate capability ids and hook ids without partially adding hooks', async () => {
    const registry = await import('./dot-extension-registry.js');
    registry.registerDotExtension(registration('existing'));
    expect(() => registry.registerDotExtension(registration('existing'))).toThrow(
      'Duplicate dot extension'
    );
    const conflict = registration('conflict');
    conflict.hooks.promptSections = [{ id: 'would-leak', order: 0, lines: () => [] }];
    conflict.hooks.statusSections = [{ id: 'existing', collect: () => ({}) }];
    expect(() => registry.registerDotExtension(conflict)).toThrow('status section');
    expect(registry.DOT_PROMPT_SECTIONS).toEqual([]);
    expect(registry.listDotExtensions().map((entry) => entry.id)).toEqual(['existing']);
    // A failed registration must not reserve its id.
    registry.registerDotExtension(registration('conflict'));
  });

  it('rejects repeated hook identities within one bundle', async () => {
    const registry = await import('./dot-extension-registry.js');
    const input = registration('duplicate-hooks');
    input.hooks.statusSections = [
      { id: 'same', collect: () => ({}) },
      { id: 'same', collect: () => ({}) },
    ];
    expect(() => registry.registerDotExtension(input)).toThrow('status section');
    expect(registry.DOT_STATUS_SECTIONS).toEqual([]);
  });

  it.each(['name', 'fence'] as const)(
    'rejects colliding tool %s across bundles',
    async (identity) => {
      const registry = await import('./dot-extension-registry.js');
      registry.registerDotExtension({
        ...registration('first'),
        hooks: { wakeTools: [tool('first-tool', 'first-fence')] },
      });
      const second = tool(
        identity === 'name' ? 'first-tool' : 'second-tool',
        identity === 'fence' ? 'first-fence' : 'second-fence'
      );
      expect(() =>
        registry.registerDotExtension({
          ...registration('second'),
          hooks: { wakeTools: [second] },
        })
      ).toThrow(`wake tool ${identity}`);
      expect(registry.DOT_WAKE_TOOLS).toHaveLength(1);
      expect(registry.listDotExtensions()).toHaveLength(1);
    }
  );

  it('rejects missing provenance and invalid order before registration', async () => {
    const registry = await import('./dot-extension-registry.js');
    expect(() => registry.registerDotExtension(registration('bad', NaN))).toThrow('finite order');
    expect(() =>
      registry.registerDotExtension({
        ...registration('bad'),
        metadata: { provenance: 'plugin' },
      })
    ).toThrow('provenance source');
    expect(registry.listDotExtensions()).toEqual([]);
  });

  it.each(['core-name', 'core-fence', 'mismatched-name'] as const)(
    'rejects invalid tool identity %s without adding any hooks',
    async (identity) => {
      const registry = await import('./dot-extension-registry.js');
      const { DOT_PROPOSE_TOOL_NAME, DOT_PROPOSALS_FENCE } = await import('./dot-extensions.js');
      const invalid = tool(
        identity === 'core-name' ? DOT_PROPOSE_TOOL_NAME : 'custom-name',
        identity === 'core-fence' ? DOT_PROPOSALS_FENCE : 'custom-fence'
      );
      if (identity === 'mismatched-name') invalid.definition.name = 'unreachable-name';
      expect(() =>
        registry.registerDotExtension({
          ...registration('invalid-tool'),
          hooks: {
            promptSections: [{ id: 'would-leak', order: 0, lines: () => [] }],
            wakeTools: [invalid],
          },
        })
      ).toThrow(identity === 'mismatched-name' ? 'definition name must match' : 'reserved core');
      expect(registry.DOT_WAKE_TOOLS).toEqual([]);
      expect(registry.DOT_PROMPT_SECTIONS).toEqual([]);
      expect(registry.listDotExtensions()).toEqual([]);
      // Validation failure does not consume the capability id.
      registry.registerDotExtension(registration('invalid-tool'));
    }
  );

  it('initializes built-ins exactly once using the same governed API', async () => {
    const registry = await import('./dot-extension-registry.js');
    const bootstrap = await import('./dot-extension-bootstrap.js');
    const toolsBefore = [...registry.DOT_WAKE_TOOLS];
    bootstrap.ensureDotExtensionsRegistered();
    bootstrap.ensureDotExtensionsRegistered();
    expect(registry.DOT_WAKE_TOOLS).toEqual(toolsBefore);
    expect(registry.listDotExtensions()).toEqual([
      {
        id: 'dot-builtin-capabilities',
        order: 0,
        metadata: { provenance: 'builtin', source: 'libs/core/dot/dot-extension-bootstrap.ts' },
      },
    ]);
    expect(() =>
      registry.registerDotExtension({
        ...registration('duplicate-built-in'),
        hooks: { wakeTools: [registry.DOT_WAKE_TOOLS[0]] },
      })
    ).toThrow('wake tool name');
  });
});
