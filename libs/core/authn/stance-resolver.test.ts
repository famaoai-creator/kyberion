import { afterEach, describe, it, expect, vi } from 'vitest';

const existingPaths = new Set<string>();
const stanceWarn = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>();
  return {
    ...actual,
    createLogger: (name: string, ...rest: unknown[]) => {
      const created = (actual.createLogger as (...args: unknown[]) => Record<string, unknown>)(
        name,
        ...rest
      );
      return name === 'stance-resolver' ? { ...created, warn: stanceWarn } : created;
    },
  };
});
vi.mock('../fs-primitives.js', () => ({
  rawExistsSync: (p: string) => existingPaths.has(p),
  // assertSafeRepositoryPath lstats every path segment to reject symlink
  // traversal. This fixture has no symlinks: paths the test declared are
  // regular files, anything else reports ENOENT (which ends the walk).
  rawLstatSync: (p: string) => {
    if (!existingPaths.has(p)) {
      const error = new Error(
        `ENOENT: no such file or directory, lstat '${p}'`
      ) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
  },
}));

const {
  activeStance,
  stanceRoot,
  overlayCandidates,
  resolveOverlay,
  InvalidStanceSlugError,
  __test__,
} = await import('./stance-resolver.js');

describe('stance-resolver', () => {
  describe('activeStance', () => {
    it('returns null when env var is unset', () => {
      expect(activeStance({})).toBeNull();
    });

    it('returns null when env var is empty string', () => {
      expect(activeStance({ ['KYBERION_STANCE']: '' })).toBeNull();
    });

    it('returns null when env var is whitespace', () => {
      expect(activeStance({ ['KYBERION_STANCE']: '   ' })).toBeNull();
    });

    it('returns the slug when valid', () => {
      expect(activeStance({ ['KYBERION_STANCE']: 'acme-corp' })).toBe('acme-corp');
      expect(activeStance({ ['KYBERION_STANCE']: 'client_a' })).toBe('client_a');
      expect(activeStance({ ['KYBERION_STANCE']: 'a' })).toBe('a');
      expect(activeStance({ ['KYBERION_STANCE']: '1demo' })).toBe('1demo');
    });

    it('trims surrounding whitespace', () => {
      expect(activeStance({ ['KYBERION_STANCE']: '  acme  ' })).toBe('acme');
    });

    it('throws on uppercase', () => {
      expect(() => activeStance({ ['KYBERION_STANCE']: 'ACME' })).toThrow(InvalidStanceSlugError);
    });

    it('throws on path traversal attempts', () => {
      expect(() => activeStance({ ['KYBERION_STANCE']: '../etc' })).toThrow(InvalidStanceSlugError);
      expect(() => activeStance({ ['KYBERION_STANCE']: 'a/b' })).toThrow(InvalidStanceSlugError);
    });

    it('throws on leading hyphen', () => {
      expect(() => activeStance({ ['KYBERION_STANCE']: '-bad' })).toThrow(InvalidStanceSlugError);
    });

    it('throws on dots, spaces, special chars', () => {
      expect(() => activeStance({ ['KYBERION_STANCE']: 'a.b' })).toThrow(InvalidStanceSlugError);
      expect(() => activeStance({ ['KYBERION_STANCE']: 'a b' })).toThrow(InvalidStanceSlugError);
      expect(() => activeStance({ ['KYBERION_STANCE']: 'a$b' })).toThrow(InvalidStanceSlugError);
    });
  });

  describe('stanceRoot', () => {
    it('returns null when no slug active', () => {
      expect(stanceRoot('', {})).toBeNull();
    });

    it('returns absolute path under knowledge/personal/stances/{slug} when active', () => {
      const root = stanceRoot('', { ['KYBERION_STANCE']: 'acme' });
      expect(root).not.toBeNull();
      expect(root!.endsWith('/knowledge/personal/stances/acme')).toBe(true);
    });

    it('joins subPath when provided', () => {
      const p = stanceRoot('identity.json', { ['KYBERION_STANCE']: 'acme' });
      expect(p!.endsWith('/knowledge/personal/stances/acme/identity.json')).toBe(true);
    });

    it('rejects traversal in a stance overlay subPath', () => {
      expect(() => stanceRoot('../outside.json', { ['KYBERION_STANCE']: 'acme' })).toThrow(
        '[STANCE_SCOPE]'
      );
    });
  });

  describe('overlayCandidates', () => {
    it('returns both overlay null and base path when no slug active', () => {
      const { overlay, base } = overlayCandidates('connections/slack.json', {});
      expect(overlay).toBeNull();
      expect(base.endsWith('/knowledge/personal/connections/slack.json')).toBe(true);
    });

    it('returns both candidates when slug active', () => {
      const { overlay, base } = overlayCandidates('connections/slack.json', {
        ['KYBERION_STANCE']: 'acme',
      });
      expect(overlay!.endsWith('/knowledge/personal/stances/acme/connections/slack.json')).toBe(
        true
      );
      expect(base.endsWith('/knowledge/personal/connections/slack.json')).toBe(true);
    });
  });

  describe('resolveOverlay', () => {
    afterEach(() => {
      existingPaths.clear();
    });

    it('falls back to knowledge/personal when no customer slug is active', () => {
      const p = resolveOverlay('my-identity.json', {});
      expect(p.endsWith('/knowledge/personal/my-identity.json')).toBe(true);
    });

    it('prefers the customer overlay when it exists, even if personal also exists', () => {
      const env = { ['KYBERION_STANCE']: 'acme' };
      const overlayPath = stanceRoot('my-identity.json', env)!;
      const personalPath = overlayCandidates('my-identity.json', env).base;
      existingPaths.add(overlayPath);
      existingPaths.add(personalPath);

      expect(resolveOverlay('my-identity.json', env)).toBe(overlayPath);
    });

    it('falls back to personal when a slug is active but the overlay file is absent', () => {
      const env = { ['KYBERION_STANCE']: 'acme' };
      const personalPath = overlayCandidates('my-identity.json', env).base;
      existingPaths.add(personalPath);

      expect(resolveOverlay('my-identity.json', env)).toBe(personalPath);
    });

    it('returns the customer path (for writes) when a slug is active but neither file exists', () => {
      const env = { ['KYBERION_STANCE']: 'acme' };
      const overlayPath = stanceRoot('my-identity.json', env)!;

      expect(resolveOverlay('my-identity.json', env)).toBe(overlayPath);
    });

    it('returns the personal path (for writes) when no slug is active and neither file exists', () => {
      const personalPath = overlayCandidates('my-identity.json', {}).base;

      expect(resolveOverlay('my-identity.json', {})).toBe(personalPath);
    });
  });
});

describe('stance-resolver retired KYBERION_CUSTOMER', () => {
  afterEach(() => {
    existingPaths.clear();
    vi.restoreAllMocks();
  });

  it('maps KYBERION_CUSTOMER to an existing stance directory, once, with a diagnostic warning', async () => {
    const { activeStance, __test__ } = await import('./stance-resolver.js');
    __test__.resetLegacyEnvWarning();
    stanceWarn.mockClear();
    const root = '/repo';
    existingPaths.add('/repo/knowledge/personal/stances/legacy');

    expect(activeStance({ KYBERION_CUSTOMER: 'legacy' }, root)).toBe('legacy');
    expect(activeStance({ KYBERION_CUSTOMER: 'legacy' }, root)).toBe('legacy');
    expect(stanceWarn).toHaveBeenCalledTimes(1);
    expect(stanceWarn.mock.calls[0][0]).toMatch(
      /^KYBERION_CUSTOMER is retired — .+ \| next: set KYBERION_STANCE=legacy .+ \| evidence: /u
    );
    expect(activeStance({ KYBERION_STANCE: 'current', KYBERION_CUSTOMER: 'legacy' }, root)).toBe(
      'current'
    );
    expect(activeStance({}, root)).toBeNull();
  });

  it('ignores KYBERION_CUSTOMER when no stance directory exists to map it to', async () => {
    const { activeStance, __test__ } = await import('./stance-resolver.js');
    __test__.resetLegacyEnvWarning();
    stanceWarn.mockClear();
    expect(activeStance({ KYBERION_CUSTOMER: 'acme' }, '/repo')).toBeNull();
    expect(stanceWarn).toHaveBeenCalledTimes(1);
    expect(stanceWarn.mock.calls[0][0]).toMatch(/^KYBERION_CUSTOMER is retired — ignored /u);
    __test__.resetLegacyEnvWarning();
    // A malformed legacy value is ignored instead of failing the process.
    expect(activeStance({ KYBERION_CUSTOMER: '../etc' }, '/repo')).toBeNull();
  });

  it('classifies legacy customer/<slug> entries into stance and tenant files', async () => {
    const { isStanceEntry } = await import('./stance-resolver.js');
    for (const entry of [
      'identity.json',
      'policy/x.json',
      'connections/slack.json',
      'tenants/a.json',
    ])
      expect(isStanceEntry(entry), entry).toBe(true);
    for (const entry of [
      'customer.json',
      'vision.md',
      'deals/d.json',
      'connections/channel-bindings.json',
    ])
      expect(isStanceEntry(entry), entry).toBe(false);
  });
});
