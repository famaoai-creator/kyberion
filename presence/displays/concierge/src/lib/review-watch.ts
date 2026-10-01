import type { ObservationReviewDigest } from './observation-review-types';

export const REVIEW_INTERVAL_MS = 5 * 60 * 1000;
export const REVIEW_DURATION_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Browser lifetime only. Stop/error/deadline invalidate even a reader that ignores abort. */
export function startReviewWatch(options: {
  repeat: boolean;
  read: (signal: AbortSignal) => Promise<ObservationReviewDigest>;
  onResult: (digest: ObservationReviewDigest) => void;
  onChecking: () => void;
  onStop: () => void;
  onError: () => void;
}): () => void {
  let stopped = false;
  let request: AbortController | undefined;
  let interval: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expiresAt = options.repeat ? Date.now() + REVIEW_DURATION_MS : Infinity;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(interval);
    clearTimeout(timeout);
    clearTimeout(deadline);
    request?.abort();
    options.onStop();
  };
  const fail = () => {
    if (stopped) return;
    stop();
    options.onError();
  };
  const check = async () => {
    if (stopped) return;
    if (Date.now() >= expiresAt) {
      stop();
      return;
    }
    request = new AbortController();
    options.onChecking();
    timeout = setTimeout(fail, REQUEST_TIMEOUT_MS);
    try {
      const digest = await options.read(request.signal);
      if (stopped) return;
      if (Date.now() >= expiresAt) {
        stop();
        return;
      }
      clearTimeout(timeout);
      options.onResult(digest);
      if (options.repeat) interval = setTimeout(() => void check(), REVIEW_INTERVAL_MS);
      else stop();
    } catch {
      fail();
    }
  };
  if (options.repeat) deadline = setTimeout(stop, REVIEW_DURATION_MS);
  void check();
  return stop;
}
