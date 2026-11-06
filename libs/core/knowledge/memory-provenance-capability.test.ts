import { describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import {
  currentMemoryProvenanceReadCapability,
  memoryProvenanceReadAllowed,
  memoryProvenanceStatePath,
  withMemoryProvenanceReadCapability,
} from './memory-provenance-capability.js';

const scope = { tier: 'public' as const };

describe('memory provenance read grant (G2: module-private, synchronous)', () => {
  it('is live only while its callback runs and allows only the exact state read', () => {
    const file = memoryProvenanceStatePath(scope);
    withMemoryProvenanceReadCapability(scope, () => {
      expect(currentMemoryProvenanceReadCapability()?.file).toBe(file);
      expect(memoryProvenanceReadAllowed(file, 'read')).toBe(true);
      expect(memoryProvenanceReadAllowed(file + '.other', 'read')).toBe(false);
      expect(memoryProvenanceReadAllowed(file, 'write')).toBe(false);
    });
    expect(currentMemoryProvenanceReadCapability()).toBeUndefined();
    expect(memoryProvenanceReadAllowed(file, 'read')).toBe(false);
  });

  it('returns a snapshot: mutating it changes nothing', () => {
    withMemoryProvenanceReadCapability(scope, () => {
      const snapshot = currentMemoryProvenanceReadCapability() as { file: string };
      expect(() => {
        snapshot.file = 'knowledge/confidential/acme/secret.json';
      }).toThrow();
      expect(memoryProvenanceReadAllowed('knowledge/confidential/acme/secret.json', 'read')).toBe(
        false
      );
    });
  });

  it('is synchronous: no thenable, no captured continuation', async () => {
    expect(() => withMemoryProvenanceReadCapability(scope, () => Promise.resolve(1))).toThrow(
      'synchronous only'
    );
    expect(() => withMemoryProvenanceReadCapability(scope, () => ({ then() {} }))).toThrow(
      'synchronous only'
    );
    let later: Promise<unknown> | undefined;
    withMemoryProvenanceReadCapability(scope, () => {
      later = new Promise((resolve) =>
        setTimeout(() => resolve(currentMemoryProvenanceReadCapability()), 0)
      );
    });
    await expect(later).resolves.toBeUndefined();
  });
});

describe('memory provenance read grant authority (G2: no reader role)', () => {
  it('authorizes its exact read for a role-less caller and narrows every other I/O', () => {
    const owner = 'c'.repeat(64);
    const personal = { tier: 'personal' as const, owner_nhi: owner };
    vi.stubEnv('VITEST', '');
    try {
      const file = memoryProvenanceStatePath(personal);
      expect(file).toMatch(/^active\/personal\/owners\/[a-f0-9]{64}\/memory\/provenance\.json$/);
      const abs = pathResolver.rootResolve(file);
      withExecutionContext('chronos_tenant_runner', () => {
        const before = validateReadPermission(abs).allowed;
        withMemoryProvenanceReadCapability(personal, () => {
          expect(validateReadPermission(abs)).toMatchObject({ allowed: true });
          expect(
            validateReadPermission(pathResolver.rootResolve('knowledge/public/x.md')).reason
          ).toContain('MEMORY_PROVENANCE_READ_SCOPE');
          expect(validateWritePermission(abs).reason).toContain('MEMORY_PROVENANCE');
        });
        expect(validateReadPermission(abs).allowed).toBe(before);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
