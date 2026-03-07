import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { 
  detectTier, 
  canFlowTo, 
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
  rootDir
} from './index.js';

describe('core library bundle', () => {
  describe('tier-guard', () => {
    it('should detect public tier', () => {
      const tier = detectTier(path.join(rootDir(), 'knowledge/orchestration/global_skill_index.json'));
      expect(tier).toBe('public');
    });

    it('should validate tier flow correctly', () => {
      expect(canFlowTo('public', 'public')).toBe(true);
      expect(canFlowTo('personal', 'public')).toBe(false);
      expect(canFlowTo('personal', 'personal')).toBe(true);
      expect(canFlowTo('confidential', 'public')).toBe(false);
    });

    it('should scan for confidential markers', () => {
      const result = scanForConfidentialMarkers('The API_KEY is abc123 and PASSWORD is secret');
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
      const result = wrapSkill('test-fail', () => { throw new Error('boom'); });
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
      const err = new KyberionError(ERROR_CODES.EXECUTION_ERROR, 'timeout', { context: { s: 't' } });
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
      await new Promise(r => setTimeout(r, 25));
      expect(cache.get('short')).toBeUndefined();
      expect(cache.get('long')).toBe(2);
    });
  });
});
