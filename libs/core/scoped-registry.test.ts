import { describe, expect, it } from 'vitest';
import { ScopedRegistry, canonicalizeScopedRegistryScope } from './scoped-registry.js';

describe('ScopedRegistry', () => {
  it('inherits and shadows by scope specificity, independent of registration order', () => {
    const registry = new ScopedRegistry<string>();
    registry.register({ tenant: 'acme' }, 'policy', 'tenant');
    registry.register({ tenant: 'acme', organization: 'org-a' }, 'policy', 'organization');
    registry.register(
      { tenant: 'acme', organization: 'org-a', project: 'project-a' },
      'other',
      'project'
    );

    expect(
      registry.get({ tenant: 'acme', organization: 'org-a', project: 'project-a' }, 'policy')
    ).toBe('organization');
    expect(
      registry
        .list({ tenant: 'acme', organization: 'org-a', project: 'project-a' })
        .map((e) => e.id)
    ).toEqual(['other', 'policy']);
    expect(registry.get({ tenant: 'acme', organization: 'org-b' }, 'policy')).toBe('tenant');
  });

  it('rejects equal-depth incomparable matches and supports reversible events', () => {
    const registry = new ScopedRegistry<string>();
    const events: string[] = [];
    registry.on('added', ({ entry }) => events.push(`add:${entry.id}`));
    registry.on('removed', ({ entry }) => events.push(`remove:${entry.id}`));
    const dispose = registry.register({ tenant: 'acme', project: 'project-a' }, 'x', 'a');
    registry.register({ tenant: 'acme', organization: 'org-a' }, 'x', 'b');

    expect(() =>
      registry.get({ tenant: 'acme', organization: 'org-a', project: 'project-a' }, 'x')
    ).toThrow('[SCOPED_REGISTRY_AMBIGUOUS]');
    dispose();
    expect(registry.get({ tenant: 'acme', organization: 'org-a', project: 'project-a' }, 'x')).toBe(
      'b'
    );
    expect(events).toEqual(['add:x', 'add:x', 'remove:x']);
  });

  it('canonicalizes scope keys and rejects empty identifiers', () => {
    expect(canonicalizeScopedRegistryScope({ tenant: ' acme ', mission: ' M-1 ' })).toBe(
      'tenant_slug=acme|organization_id=|project_id=|mission_id=M-1|task_id=|session='
    );
    expect(canonicalizeScopedRegistryScope({ tenant_slug: 'acme', mission_id: 'M-1' })).toBe(
      'tenant_slug=acme|organization_id=|project_id=|mission_id=M-1|task_id=|session='
    );
    expect(() => canonicalizeScopedRegistryScope({ tenant: 'acme', tenant_slug: 'other' })).toThrow(
      '[SCOPED_REGISTRY_SCOPE] conflicting values'
    );
    const registry = new ScopedRegistry<string>();
    expect(() => registry.register({ tenant: 'acme' }, ' ', 'value')).toThrow(
      '[SCOPED_REGISTRY_CONFIG]'
    );
    expect(() => registry.register({ tenant: '' }, 'x', 'value')).toThrow(
      '[SCOPED_REGISTRY_SCOPE]'
    );
  });
});
