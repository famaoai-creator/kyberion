import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { PathAttributionError, tenantOfPath, tierOfPath } from './path-tenant-attribution.js';

describe('path tenant attribution', () => {
  const root = pathResolver.rootDir();

  it('names the tier and owning tenant of repository paths', () => {
    expect(tierOfPath(path.join(root, 'knowledge/confidential/acme/v.mp4'))).toBe('confidential');
    expect(tenantOfPath(path.join(root, 'knowledge/confidential/acme/v.mp4'))).toBe('acme');
    expect(tenantOfPath(path.join(root, 'knowledge/confidential/tenant-groups/x.md'))).toBe(
      undefined
    );
    expect(tenantOfPath(path.join(root, 'active/projects/confidential/acme/x/v.mp4'))).toBe('acme');
    expect(tenantOfPath(path.join(root, 'active/shared/tmp/v.mp4'))).toBeUndefined();
  });

  it('fails closed with a typed error whose detail carries no code prefix', () => {
    let failure: unknown;
    try {
      tenantOfPath(path.join(root, 'knowledge/confidential/Not_A_Slug/v.mp4'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PathAttributionError);
    const typed = failure as PathAttributionError;
    expect(typed.code).toBe('TENANT_UNRESOLVED');
    expect(typed.message).toBe(`[TENANT_UNRESOLVED] ${typed.detail}`);
    expect(typed.detail).not.toMatch(/^\[/);

    expect(() => tierOfPath('/definitely/outside/the/repo.mp4')).toThrow(PathAttributionError);
    expect(() => tierOfPath('/definitely/outside/the/repo.mp4')).toThrow(/TIER_UNRESOLVED/);
  });
});
