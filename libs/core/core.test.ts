import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { ui, fileUtils } from './core.js';
import {
  detectTier,
  scanForConfidentialMarkers,
  wrapSkill,
  wrapSkillAsync,
  classifier,
  validateFilePath,
  safeJsonParse,
  requireArgs,
  KyberionError,
  ERROR_CODES,
  Cache,
  rootDir,
} from './index.js';

const originalArgv = process.argv.slice();
const readlineMock = vi.hoisted(() => ({
  createInterface: vi.fn(() => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb('y'),
    close: vi.fn(),
  })),
}));

vi.mock('node:readline', () => ({
  createInterface: readlineMock.createInterface,
}));

const visionResolverMock = vi.hoisted(() => ({
  resolveVision: vi.fn(),
}));

vi.mock('./vision-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision-resolver.js')>();
  return {
    ...actual,
    resolveVision: visionResolverMock.resolveVision,
  };
});

describe('core library bundle', () => {
  beforeEach(() => {
    process.argv = [...originalArgv];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.argv = [...originalArgv];
  });

  describe('tier-guard', () => {
    it('should detect public tier', () => {
      const tier = detectTier(
        path.join(rootDir(), 'knowledge/product/orchestration/global_actuator_index.json')
      );
      expect(tier).toBe('public');
    });

    it('should scan for confidential markers', () => {
      const result = scanForConfidentialMarkers(
        'AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and secret: "1234567890abcdef1234"'
      );
      expect(result.hasMarkers).toBe(true);
      expect(result.markers.length).toBeGreaterThanOrEqual(2);

      const clean = scanForConfidentialMarkers('Safe public content');
      expect(clean.hasMarkers).toBe(false);
    });
  });

  describe('skill-wrapper', () => {
    it('should wrap synchronous skills with success format', () => {
      const result = wrapSkill('test-sync', () => ({ hello: 'world' }));
      expect(result.skill).toBe('test-sync');
      expect(result.status).toBe('success');
      expect(result.data.hello).toBe('world');
      expect(result.metadata.duration_ms).toBeDefined();
    });

    it('should wrap synchronous skills with error format on throw', () => {
      const result = wrapSkill('test-fail', () => {
        throw new Error('boom');
      });
      expect(result.status).toBe('error');
      expect(result.error.message).toBe('boom');
    });

    it('should wrap asynchronous skills correctly', async () => {
      const result = await wrapSkillAsync('test-async', async () => ({ value: 42 }));
      expect(result.status).toBe('success');
      expect(result.data.value).toBe(42);
    });
  });

  describe('classifier', () => {
    it('should classify text into correct categories', () => {
      const result = (classifier as any).classify(
        'Deploy the API Server',
        {
          tech: ['API', 'Server', 'Deploy'],
          finance: ['Budget', 'Cost'],
        },
        { resultKey: 'domain' }
      );
      expect(result.domain).toBe('tech');
      expect(result.matches).toBe(3);
    });

    it('should return unknown for no matches', () => {
      const result = (classifier as any).classify('lorem ipsum', { tech: ['API'] });
      expect(result.category).toBe('unknown');
    });
  });

  describe('validators', () => {
    it('should throw on missing file paths', () => {
      expect(() => validateFilePath(null as any)).toThrow('Missing');
    });

    it('should parse JSON safely or throw', () => {
      expect((safeJsonParse('{"a":1}', 'test') as any).a).toBe(1);
      expect(() => safeJsonParse('invalid', 'test')).toThrow('Invalid test');
    });

    it('should detect missing arguments', () => {
      expect(() => requireArgs({ a: 1 }, ['a', 'b'])).toThrow('b');
    });
  });

  describe('error-codes', () => {
    it('should have structured fields in SkillError', () => {
      const err = new KyberionError(ERROR_CODES.VALIDATION_ERROR, 'bad input');
      expect(err.code).toBe('E200');
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('bad input');
    });

    it('should serialize SkillError to JSON', () => {
      const err = new KyberionError(ERROR_CODES.EXECUTION_ERROR, 'timeout', {
        context: { s: 't' },
      });
      const json = err.toJSON();
      expect(json.code).toBe('E300');
      expect(json.retryable).toBe(true);
      expect(json.context.s).toBe('t');
    });
  });

  describe('Cache', () => {
    it('should evict LRU items', () => {
      const cache = new Cache(3, 10000);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size).toBe(3);
      cache.get('a'); // 'a' is now most recent, 'b' is LRU
      cache.set('d', 4);
      expect(cache.size).toBe(3);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe(1);
    });

    it('should expire items based on TTL', async () => {
      const cache = new Cache(10, 1000);
      cache.set('short', 1, 10);
      cache.set('long', 2, 500);
      vi.setSystemTime(new Date('2026-07-04T00:00:00.025Z'));
      expect(cache.get('short')).toBeUndefined();
      expect(cache.get('long')).toBe(2);
    });
  });

  describe('ui.confirm', () => {
    it('auto-confirms non-destructive prompts when -y is present', async () => {
      process.argv = ['node', 'test', '-y'];
      await expect(ui.confirm('continue?')).resolves.toBe(true);
      expect(readlineMock.createInterface).not.toHaveBeenCalled();
    });

    it('prompts for destructive operations even when -y is present', async () => {
      process.argv = ['node', 'test', '-y'];
      await expect(ui.confirm('delete everything?', { destructive: true })).resolves.toBe(true);
      expect(readlineMock.createInterface).toHaveBeenCalled();
    });
  });

  // CO-01: getGoldenRule() must be tenant-aware. It delegates to resolveVision()
  // with no explicit tenantSlug, which is only correct because resolveVision()
  // itself falls back to customerResolver.activeCustomer() (the KYBERION_CUSTOMER
  // env var) when no tenantSlug is passed. That fallback wiring was previously
  // unverified by any test — this locks in the delegation contract.
  describe('fileUtils.getGoldenRule (CO-01 tenant awareness)', () => {
    afterEach(() => {
      visionResolverMock.resolveVision.mockReset();
    });

    it('returns the resolved vision text when the active tenant has one', () => {
      visionResolverMock.resolveVision.mockReturnValue({
        tenant_slug: 'acme',
        source_path: '/customer/acme/vision.md',
        source_kind: 'customer',
        title: 'ACME Vision',
        raw: '# ACME Vision\n\n## Steering\n- Tenant priority first\n',
        sections: { soul: [], steering: ['Tenant priority first'], destination: [] },
      });

      expect(fileUtils.getGoldenRule()).toContain('Tenant priority first');
      // No tenantSlug argument: tenant resolution is resolveVision's job (via
      // customerResolver.activeCustomer()), not getGoldenRule's.
      expect(visionResolverMock.resolveVision).toHaveBeenCalledWith();
    });

    it('falls back to the global default when resolveVision has no tenant/global content', () => {
      visionResolverMock.resolveVision.mockReturnValue({
        tenant_slug: null,
        source_path: '/vision/_default.md',
        source_kind: 'global',
        title: null,
        raw: '',
        sections: { soul: [], steering: [], destination: [] },
      });

      const rule = fileUtils.getGoldenRule();
      expect(typeof rule).toBe('string');
      expect(rule.length).toBeGreaterThan(0);
    });
  });
});
