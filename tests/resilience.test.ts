import { describe, it, expect } from 'vitest';
import { withRetry } from '@agent/core';

describe('Intelligent Retry & Resilience', () => {
  
  it('Scenario: Successful retry after failures', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Transient failure');
      }
      return 'Success on attempt 3';
    }, { 
      maxRetries: 5, 
      initialDelayMs: 10,
      jitter: false 
    });

    expect(result).toBe('Success on attempt 3');
    expect(attempts).toBe(3);
  });

  it('Scenario: Ultimate failure after max retries', async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw new Error('Permanent failure');
      }, { 
        maxRetries: 2, 
        initialDelayMs: 10,
        jitter: false 
      });
      throw new Error('Should have failed');
    } catch (err: any) {
      expect(err.message).toBe('Permanent failure');
      expect(attempts).toBe(3); // 1 initial + 2 retries
    }
  });

  it('Scenario: shouldRetry predicate', async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw new Error('Fatal error');
      }, { 
        maxRetries: 5,
        shouldRetry: (err) => err.message !== 'Fatal error'
      });
    } catch (err: any) {
      expect(attempts).toBe(1); // Should stop immediately
    }
  });
});
