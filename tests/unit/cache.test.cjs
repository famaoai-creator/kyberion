const { test, describe } = require('node:test');
const assert = require('node:assert');
const { Cache } = require('../../scripts/lib/core.cjs');

describe('Cache Memory Optimization', () => {
  test('should evict LRU items when capacity is exceeded', () => {
    const cache = new Cache(3, 10000);
    
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    
    assert.strictEqual(cache.size, 3);
    assert.strictEqual(cache.get('a'), 1); // Access 'a', making 'b' the LRU
    
    cache.set('d', 4); // Should evict 'b'
    
    assert.strictEqual(cache.size, 3);
    assert.strictEqual(cache.get('b'), undefined);
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('d'), 4);
  });

  test('should expire items based on custom TTL', async () => {
    const cache = new Cache(10, 1000);
    
    cache.set('short', 1, 10); // 10ms TTL
    cache.set('long', 2, 500); // 500ms TTL
    
    await new Promise(r => setTimeout(r, 20));
    
    assert.strictEqual(cache.get('short'), undefined, 'Short item should expire');
    assert.strictEqual(cache.get('long'), 2, 'Long item should persist');
  });

  test('should not leak memory with repeated overwrites', () => {
    const cache = new Cache(100, 10000);
    const initialMemory = process.memoryUsage().heapUsed;
    
    // Simulate high churn
    for (let i = 0; i < 10000; i++) {
      cache.set(`key-${i % 200}`, new Array(1000).fill('x').join(''));
    }
    
    assert.strictEqual(cache.size <= 100, true, 'Cache size should respect limit');
    
    // Force GC if possible (not reliable in JS, but we check size constraint)
    global.gc && global.gc();
    
    const finalMemory = process.memoryUsage().heapUsed;
    // Basic sanity check: 100 strings of 1KB shouldn't explode memory
    // Allowing some overhead, but it shouldn't be huge
    const diff = finalMemory - initialMemory;
    // This is a heuristic assertion, mainly ensuring no crash or massive growth
    assert.ok(diff < 50 * 1024 * 1024, 'Memory growth should be reasonable'); 
  });
});
