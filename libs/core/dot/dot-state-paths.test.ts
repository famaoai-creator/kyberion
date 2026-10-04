import { describe, expect, it } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import { dotMemoryPath, dotStatePath } from './dot-state-paths.js';

const charter = (scope: DotCharter['scope']) => ({ dot_id: 'demo-dot', scope }) as DotCharter;

describe('dotStatePath', () => {
  it('places untenanted dots directly under the dot domain', () => {
    expect(dotStatePath(charter({ tier: 'public' }), 'work-results.jsonl')).toBe(
      'active/shared/runtime/dot/work-results.jsonl'
    );
  });
  it('places tenant dots under the physical tenant namespace', () => {
    expect(
      dotStatePath(
        charter({ tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' }),
        'memory',
        'x.json'
      )
    ).toBe('active/shared/runtime/dot/tenants/acme/organizations/org-1/memory/x.json');
    expect(dotMemoryPath(charter({ tier: 'confidential', tenant_slug: 'acme' }))).toBe(
      'active/shared/runtime/dot/tenants/acme/memory/demo-dot.json'
    );
  });
});
