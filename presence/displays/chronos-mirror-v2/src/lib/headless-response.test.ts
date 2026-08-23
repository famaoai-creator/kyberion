import { describe, expect, it } from 'vitest';
import { headlessManifestForViewer, parseHeadlessLimit } from './headless-response';

describe('headless response policy', () => {
  it('filters write operations from readonly manifests and exposes the resolved scope separately', () => {
    const manifest = headlessManifestForViewer({
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      tierAccess: ['public'],
      source: 'token',
      principalId: 'viewer-a',
    });

    expect(manifest.operations.every((operation) => operation.effect === 'read')).toBe(true);
    expect(manifest.operations.map((operation) => operation.operation_id)).not.toContain(
      'chronos.work_items.update_status'
    );
  });

  it('rejects malformed limits instead of silently changing the requested query', () => {
    expect(parseHeadlessLimit('5', 8, 50)).toBe(5);
    expect(() => parseHeadlessLimit('0', 8, 50)).toThrow('invalid limit');
    expect(() => parseHeadlessLimit('not-a-number', 8, 50)).toThrow('invalid limit');
  });
});
