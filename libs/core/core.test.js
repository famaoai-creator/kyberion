"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_path_1 = __importDefault(require("node:path"));
const index_js_1 = require("./index.js");
(0, vitest_1.describe)('core library bundle', () => {
    (0, vitest_1.describe)('tier-guard', () => {
        (0, vitest_1.it)('should detect public tier', () => {
            const tier = (0, index_js_1.detectTier)(node_path_1.default.join((0, index_js_1.rootDir)(), 'knowledge/orchestration/global_skill_index.json'));
            (0, vitest_1.expect)(tier).toBe('public');
        });
        (0, vitest_1.it)('should scan for confidential markers', () => {
            const result = (0, index_js_1.scanForConfidentialMarkers)('The API_KEY is abc123 and PASSWORD is secret');
            (0, vitest_1.expect)(result.hasMarkers).toBe(true);
            (0, vitest_1.expect)(result.markers.length).toBeGreaterThanOrEqual(2);
            const clean = (0, index_js_1.scanForConfidentialMarkers)('Safe public content');
            (0, vitest_1.expect)(clean.hasMarkers).toBe(false);
        });
    });
    (0, vitest_1.describe)('skill-wrapper', () => {
        (0, vitest_1.it)('should wrap synchronous skills with success format', () => {
            const result = (0, index_js_1.wrapSkill)('test-sync', () => ({ hello: 'world' }));
            (0, vitest_1.expect)(result.skill).toBe('test-sync');
            (0, vitest_1.expect)(result.status).toBe('success');
            (0, vitest_1.expect)(result.data.hello).toBe('world');
            (0, vitest_1.expect)(result.metadata.duration_ms).toBeDefined();
        });
        (0, vitest_1.it)('should wrap synchronous skills with error format on throw', () => {
            const result = (0, index_js_1.wrapSkill)('test-fail', () => { throw new Error('boom'); });
            (0, vitest_1.expect)(result.status).toBe('error');
            (0, vitest_1.expect)(result.error.message).toBe('boom');
        });
        (0, vitest_1.it)('should wrap asynchronous skills correctly', async () => {
            const result = await (0, index_js_1.wrapSkillAsync)('test-async', async () => ({ value: 42 }));
            (0, vitest_1.expect)(result.status).toBe('success');
            (0, vitest_1.expect)(result.data.value).toBe(42);
        });
    });
    (0, vitest_1.describe)('classifier', () => {
        (0, vitest_1.it)('should classify text into correct categories', () => {
            const result = index_js_1.classifier.classify('Deploy the API Server', {
                tech: ['API', 'Server', 'Deploy'],
                finance: ['Budget', 'Cost'],
            }, { resultKey: 'domain' });
            (0, vitest_1.expect)(result.domain).toBe('tech');
            (0, vitest_1.expect)(result.matches).toBe(3);
        });
        (0, vitest_1.it)('should return unknown for no matches', () => {
            const result = index_js_1.classifier.classify('lorem ipsum', { tech: ['API'] });
            (0, vitest_1.expect)(result.category).toBe('unknown');
        });
    });
    (0, vitest_1.describe)('validators', () => {
        (0, vitest_1.it)('should throw on missing file paths', () => {
            (0, vitest_1.expect)(() => (0, index_js_1.validateFilePath)(null)).toThrow('Missing');
        });
        (0, vitest_1.it)('should parse JSON safely or throw', () => {
            (0, vitest_1.expect)((0, index_js_1.safeJsonParse)('{"a":1}', 'test').a).toBe(1);
            (0, vitest_1.expect)(() => (0, index_js_1.safeJsonParse)('invalid', 'test')).toThrow('Invalid test');
        });
        (0, vitest_1.it)('should detect missing arguments', () => {
            (0, vitest_1.expect)(() => (0, index_js_1.requireArgs)({ a: 1 }, ['a', 'b'])).toThrow('b');
        });
    });
    (0, vitest_1.describe)('error-codes', () => {
        (0, vitest_1.it)('should have structured fields in SkillError', () => {
            const err = new index_js_1.KyberionError(index_js_1.ERROR_CODES.VALIDATION_ERROR, 'bad input');
            (0, vitest_1.expect)(err.code).toBe('E200');
            (0, vitest_1.expect)(err.retryable).toBe(false);
            (0, vitest_1.expect)(err.message).toContain('bad input');
        });
        (0, vitest_1.it)('should serialize SkillError to JSON', () => {
            const err = new index_js_1.KyberionError(index_js_1.ERROR_CODES.EXECUTION_ERROR, 'timeout', { context: { s: 't' } });
            const json = err.toJSON();
            (0, vitest_1.expect)(json.code).toBe('E300');
            (0, vitest_1.expect)(json.retryable).toBe(true);
            (0, vitest_1.expect)(json.context.s).toBe('t');
        });
    });
    (0, vitest_1.describe)('Cache', () => {
        (0, vitest_1.it)('should evict LRU items', () => {
            const cache = new index_js_1.Cache(3, 10000);
            cache.set('a', 1);
            cache.set('b', 2);
            cache.set('c', 3);
            (0, vitest_1.expect)(cache.size).toBe(3);
            cache.get('a'); // 'a' is now most recent, 'b' is LRU
            cache.set('d', 4);
            (0, vitest_1.expect)(cache.size).toBe(3);
            (0, vitest_1.expect)(cache.get('b')).toBeUndefined();
            (0, vitest_1.expect)(cache.get('a')).toBe(1);
        });
        (0, vitest_1.it)('should expire items based on TTL', async () => {
            const cache = new index_js_1.Cache(10, 1000);
            cache.set('short', 1, 10);
            cache.set('long', 2, 500);
            await new Promise(r => setTimeout(r, 25));
            (0, vitest_1.expect)(cache.get('short')).toBeUndefined();
            (0, vitest_1.expect)(cache.get('long')).toBe(2);
        });
    });
});
//# sourceMappingURL=core.test.js.map