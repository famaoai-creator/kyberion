import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

import {
  loadPilotStrategyPolicyCatalog,
  resolvePilotStrategyPolicy,
} from './pilot-strategy-policy.js';

describe('pilot-strategy-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/pilot-strategy-policy.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('loads the canonical strategy labels', () => {
    const catalog = loadPilotStrategyPolicyCatalog();
    expect(catalog.title).toBe('Kyberion AI Consulting: Go-to-Market Strategy');
    expect(catalog.target).toBe('Japanese Mid-sized Enterprise (SMB) Managers');
    expect(catalog.phase_titles.education).toBe('Education');
  });

  it('resolves the policy object', () => {
    expect(resolvePilotStrategyPolicy().key_benefits_title).toBe('Key Benefits');
  });
});
