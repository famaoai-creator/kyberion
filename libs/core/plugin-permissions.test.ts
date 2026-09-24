import { describe, expect, it } from 'vitest';
import {
  formatPermissionDiffTable,
  loadPluginPermissionPolicy,
  narrowPluginPermissions,
  normalizeTierPrefix,
  parsePluginPermissionGrant,
  parsePluginPermissionRequest,
  permissionsDigest,
  PluginPermissionNarrowedError,
  type PluginPermissionPolicy,
} from './plugin-permissions.js';

function policy(overrides: Partial<PluginPermissionPolicy> = {}): PluginPermissionPolicy {
  return {
    version: 'test',
    last_updated: '2026-09-24',
    ceilings: {
      official: {
        network: { mode: 'allowlist', hosts: ['*'], allow_wildcard_hosts: true },
        fs: {
          mode: 'readwrite',
          paths: [
            { tier: 'public', prefix: '' },
            { tier: 'confidential', prefix: '{tenant}' },
          ],
        },
        ops_invoke: ['*'],
        env: ['*'],
        secrets: ['*'],
      },
      curated: {
        network: { mode: 'allowlist', hosts: ['api.example.com', '*.cdn.example.com'] },
        fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] },
        ops_invoke: ['code:*'],
        env: ['KYBERION_PUBLIC_*'],
        secrets: ['slack/bot'],
      },
      'third-party': {
        network: { mode: 'none', hosts: [] },
        fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: '' }] },
        ops_invoke: [],
        env: [],
        secrets: [],
      },
    },
    tenant_overrides: {},
    ...overrides,
  };
}

describe('parsePluginPermissionRequest', () => {
  it('treats an absent declaration as deny-by-default', () => {
    const request = parsePluginPermissionRequest(undefined);
    const { granted } = narrowPluginPermissions(request, policy(), { trust: 'official' });
    expect(granted).toEqual({
      network: { mode: 'none', hosts: [] },
      fs: { mode: 'none', paths: [] },
      ops_invoke: [],
      env: [],
      secrets: [],
    });
  });

  it('rejects unknown fields and invalid modes', () => {
    expect(() => parsePluginPermissionRequest({ process: true })).toThrow(
      '[PLUGIN_PERMISSIONS_INVALID]'
    );
    expect(() => parsePluginPermissionRequest({ network: { mode: 'any' } })).toThrow(
      'network.mode'
    );
    expect(() =>
      parsePluginPermissionRequest({
        fs: { mode: 'readonly', paths: [{ tier: 'shared', prefix: '' }] },
      })
    ).toThrow('tier');
    expect(() => parsePluginPermissionRequest('all')).toThrow('permissions must be an object');
  });
});

describe('narrowPluginPermissions', () => {
  it('keeps a wildcard host that equals a wildcard ceiling entry', () => {
    const wildcardPolicy = policy();
    wildcardPolicy.ceilings.curated.network = {
      mode: 'allowlist',
      hosts: ['*.cdn.example.com'],
      allow_wildcard_hosts: true,
    };
    const request = parsePluginPermissionRequest({
      network: { mode: 'allowlist', hosts: ['*.cdn.example.com', 'a.cdn.example.com'] },
    });
    const { granted } = narrowPluginPermissions(request, wildcardPolicy, { trust: 'curated' });
    expect(granted.network).toEqual({
      mode: 'allowlist',
      hosts: ['*.cdn.example.com', 'a.cdn.example.com'],
    });
  });
  it('never widens: third-party gets readonly public only, other capabilities stripped', () => {
    const request = parsePluginPermissionRequest({
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: 'docs/guides' }] },
      ops_invoke: ['code:run'],
      env: ['HOME'],
    });
    const { granted, diff } = narrowPluginPermissions(request, policy(), { trust: 'third-party' });
    expect(granted.fs).toEqual({
      mode: 'readonly',
      paths: [{ tier: 'public', prefix: 'docs/guides' }],
    });
    expect(granted.ops_invoke).toEqual([]);
    expect(granted.env).toEqual([]);
    expect(diff.find((entry) => entry.capability === 'fs')?.narrowed).toBe(true);
    expect(diff.find((entry) => entry.capability === 'network')?.narrowed).toBe(false);
  });

  it('intersects hosts, names and path prefixes with a curated ceiling', () => {
    const request = parsePluginPermissionRequest({
      network: {
        mode: 'allowlist',
        hosts: ['API.Example.com.', 'evil.example.org', 'img.cdn.example.com', '*.cdn.example.com'],
      },
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
      ops_invoke: ['code:run', 'system:exec', 'code:*'],
      env: ['KYBERION_PUBLIC_URL', 'AWS_SECRET_ACCESS_KEY'],
      secrets: ['slack/bot', 'github/token'],
    });
    const { granted } = narrowPluginPermissions(request, policy(), { trust: 'curated' });
    // Wildcard host requests are dropped unless the ceiling allows wildcards.
    expect(granted.network).toEqual({
      mode: 'allowlist',
      hosts: ['api.example.com', 'img.cdn.example.com'],
    });
    // Broader request intersected with a narrower ceiling yields the ceiling prefix.
    expect(granted.fs).toEqual({ mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] });
    expect(granted.ops_invoke).toEqual(['code:*', 'code:run']);
    expect(granted.env).toEqual(['KYBERION_PUBLIC_URL']);
    expect(granted.secrets).toEqual(['slack/bot']);
  });

  it('keeps confidential paths inside the installing tenant and denies other tenants', () => {
    const request = parsePluginPermissionRequest({
      fs: {
        mode: 'readonly',
        paths: [
          { tier: 'confidential', prefix: 'acme/reports' },
          { tier: 'confidential', prefix: 'globex/reports' },
          { tier: 'confidential', prefix: '' },
          { tier: 'confidential', prefix: 'acme/../globex' },
        ],
      },
    });
    const { granted } = narrowPluginPermissions(request, policy(), {
      trust: 'official',
      tenantSlug: 'acme',
    });
    // '' intersected with the '{tenant}' ceiling collapses to 'acme', which covers acme/reports.
    expect(granted.fs).toEqual({
      mode: 'readonly',
      paths: [{ tier: 'confidential', prefix: 'acme' }],
    });
  });

  it('denies cross-tenant access even when the policy ceiling names another tenant', () => {
    const permissive = policy();
    permissive.ceilings.official.fs.paths.push({ tier: 'confidential', prefix: 'globex' });
    const request = parsePluginPermissionRequest({
      fs: { mode: 'readonly', paths: [{ tier: 'confidential', prefix: 'globex/data' }] },
    });
    expect(() =>
      narrowPluginPermissions(request, permissive, { trust: 'official', tenantSlug: 'acme' })
    ).toThrow(PluginPermissionNarrowedError);
  });

  it('denies confidential paths when no tenant is known and cross-tier/personal paths by default', () => {
    const request = parsePluginPermissionRequest({
      fs: {
        mode: 'readonly',
        paths: [
          { tier: 'confidential', prefix: 'acme' },
          { tier: 'personal', prefix: '' },
          { tier: 'public', prefix: '../confidential/acme' },
        ],
      },
    });
    let caught: unknown;
    try {
      narrowPluginPermissions(request, policy(), { trust: 'official' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PluginPermissionNarrowedError);
    const error = caught as PluginPermissionNarrowedError;
    expect(error.code).toBe('PLUGIN_PERMISSION_NARROWED');
    expect(error.capability).toBe('fs');
    expect(error.granted).toBe('none');
    expect(error.requiredElevation).toContain('ceilings.official.fs');
    expect(error.requiredElevation).toContain('installing tenant');
    expect(error.requiredElevation).toContain('personal tier is denied');
  });

  it('rejects reserved tier names as tenant slugs', () => {
    const request = parsePluginPermissionRequest({
      fs: { mode: 'readonly', paths: [{ tier: 'confidential', prefix: 'public' }] },
    });
    expect(() =>
      narrowPluginPermissions(request, policy(), { trust: 'official', tenantSlug: 'public' })
    ).toThrow(PluginPermissionNarrowedError);
  });

  it('throws with human-readable elevation when network narrows to nothing', () => {
    const request = parsePluginPermissionRequest({
      network: { mode: 'allowlist', hosts: ['api.example.com'] },
    });
    let caught: PluginPermissionNarrowedError | undefined;
    try {
      narrowPluginPermissions(request, policy(), { trust: 'third-party' });
    } catch (error) {
      caught = error as PluginPermissionNarrowedError;
    }
    expect(caught?.capability).toBe('network');
    expect(caught?.requested).toBe('allowlist [api.example.com]');
    expect(caught?.requiredElevation).toMatch(
      /trust level 'third-party' must be allowed network allowlist \[api\.example\.com\]/
    );
    expect(caught?.requiredElevation).toContain('plugin-permission-policy.json');
    expect(caught?.diff.length).toBe(5);
  });

  it('throws when requested secrets narrow to nothing but not for ops/env', () => {
    expect(() =>
      narrowPluginPermissions(
        parsePluginPermissionRequest({ secrets: ['github/token'] }),
        policy(),
        {
          trust: 'third-party',
        }
      )
    ).toThrow(/secrets/);
    const { granted } = narrowPluginPermissions(
      parsePluginPermissionRequest({ ops_invoke: ['code:run'], env: ['HOME'] }),
      policy(),
      { trust: 'third-party' }
    );
    expect(granted.ops_invoke).toEqual([]);
    expect(granted.env).toEqual([]);
  });

  it('grants loopback only when the ceiling allows loopback or any host', () => {
    const request = parsePluginPermissionRequest({ network: { mode: 'loopback' } });
    expect(
      narrowPluginPermissions(request, policy(), { trust: 'official' }).granted.network.mode
    ).toBe('loopback');
    expect(() => narrowPluginPermissions(request, policy(), { trust: 'curated' })).toThrow(
      PluginPermissionNarrowedError
    );
  });

  it('applies tenant overrides narrow-only', () => {
    const request = parsePluginPermissionRequest({
      network: { mode: 'allowlist', hosts: ['api.example.com'] },
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] },
    });
    // Override tries to widen fs to readwrite on the whole tier: result stays readonly/docs.
    const widening = policy({
      tenant_overrides: {
        acme: {
          ceilings: {
            curated: {
              fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
              network: { mode: 'allowlist', hosts: ['*'] },
            },
          },
        },
      },
    });
    const widened = narrowPluginPermissions(request, widening, {
      trust: 'curated',
      tenantSlug: 'acme',
    });
    expect(widened.granted.fs).toEqual({
      mode: 'readonly',
      paths: [{ tier: 'public', prefix: 'docs' }],
    });
    expect(widened.granted.network.hosts).toEqual(['api.example.com']);

    const narrowing = policy({
      tenant_overrides: {
        acme: { ceilings: { curated: { network: { mode: 'none', hosts: [] } } } },
      },
    });
    expect(() =>
      narrowPluginPermissions(request, narrowing, { trust: 'curated', tenantSlug: 'acme' })
    ).toThrow(/network/);
    // Another tenant is unaffected by acme's override.
    expect(
      narrowPluginPermissions(request, narrowing, { trust: 'curated', tenantSlug: 'globex' })
        .granted.network.mode
    ).toBe('allowlist');
  });
});

describe('normalizeTierPrefix', () => {
  it('normalises and rejects escapes', () => {
    expect(normalizeTierPrefix('./docs//guides/')).toBe('docs/guides');
    expect(normalizeTierPrefix('')).toBe('');
    expect(normalizeTierPrefix('../x')).toBeNull();
    expect(normalizeTierPrefix('/etc')).toBeNull();
    expect(normalizeTierPrefix('C:/x')).toBeNull();
    expect(normalizeTierPrefix('a\\..\\b')).toBeNull();
  });
});

describe('permissionsDigest', () => {
  it('is stable across ordering and changes with content', () => {
    const a = parsePluginPermissionGrant({
      network: { mode: 'allowlist', hosts: ['b.example.com', 'a.example.com'] },
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] },
      ops_invoke: ['x:y', 'a:b'],
      env: [],
      secrets: [],
    });
    const b = parsePluginPermissionGrant({
      secrets: [],
      env: [],
      ops_invoke: ['a:b', 'x:y'],
      fs: { paths: [{ prefix: 'docs', tier: 'public' }], mode: 'readonly' },
      network: { hosts: ['a.example.com', 'b.example.com'], mode: 'allowlist' },
    });
    expect(permissionsDigest(a)).toBe(permissionsDigest(b));
    expect(permissionsDigest(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(permissionsDigest({ ...a, env: ['HOME'] })).not.toBe(permissionsDigest(a));
  });

  it('rejects a grant that is not fully resolved', () => {
    expect(() =>
      parsePluginPermissionGrant({ network: { mode: 'none' }, fs: { mode: 'none' } })
    ).toThrow('fully resolved');
  });
});

describe('formatPermissionDiffTable', () => {
  it('renders one row per capability with a narrowed marker', () => {
    const { diff } = narrowPluginPermissions(
      parsePluginPermissionRequest({
        fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
      }),
      policy(),
      { trust: 'third-party' }
    );
    const table = formatPermissionDiffTable(diff);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^capability\s+\| requested\s+\| ceiling\s+\| granted\s+\| narrowed$/);
    expect(lines).toHaveLength(7);
    expect(table).toMatch(
      /fs\s+\| readwrite \[public:\*\]\s+\| readonly \[public:\*\]\s+\| readonly \[public:\*\]\s+\| yes/
    );
  });
});

describe('loadPluginPermissionPolicy', () => {
  it('loads the governed policy with a deny-by-default third-party ceiling', () => {
    const governed = loadPluginPermissionPolicy();
    expect(governed.ceilings['third-party']).toMatchObject({
      network: { mode: 'none' },
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: '' }] },
      env: [],
      secrets: [],
    });
  });
});
