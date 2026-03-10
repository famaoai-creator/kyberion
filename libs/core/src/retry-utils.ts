import { logger } from '../core.js';

/**
 * Intelligent Retry Utilities for Sovereign Resilience.
 * Implements exponential backoff with jitter.
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  onRetry?: (error: Error, attempt: number) => void;
  shouldRetry?: (error: Error) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
  onRetry: (error, attempt) => {
    logger.warn(`⚠️ [Retry] Attempt ${attempt} failed: ${error.message}. Retrying...`);
  },
  shouldRetry: () => true
};

/**
 * Executes a function with intelligent retry logic.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt > opts.maxRetries || (opts.shouldRetry && !opts.shouldRetry(err))) {
        throw err;
      }

      if (opts.onRetry) opts.onRetry(err, attempt);

      let delay = opts.initialDelayMs * Math.pow(opts.factor, attempt - 1);
      delay = Math.min(delay, opts.maxDelayMs);

      if (opts.jitter) {
        delay = delay * (0.5 + Math.random());
      }

      await new Promise(res => setTimeout(res, delay));
    }
  }
}
