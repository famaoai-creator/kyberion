/**
 * Vision channel on the reasoning backend.
 *
 * The property that matters is negative: a backend that cannot see images must
 * never be asked to judge them. Failing over from a vision-capable candidate
 * to a text-only one would drop the attachments and return a confident answer
 * about pictures the model never received — which is why the failover skips
 * text-only candidates instead of degrading to them.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REASONING_IMAGES,
  backendSupportsVision,
  buildFailoverReasoningBackend,
  type ReasoningBackend,
  type ReasoningImageAttachment,
} from './reasoning-backend.js';
import { withReasoningPayloadScope } from './reasoning-egress-scope.js';

function textOnlyBackend(name: string): ReasoningBackend {
  return {
    name,
    prompt: async () => 'text reply',
    delegateTask: async () => 'delegated',
  } as unknown as ReasoningBackend;
}

function visionBackend(
  name: string,
  impl: (prompt: string, images: ReasoningImageAttachment[]) => Promise<string>
): ReasoningBackend {
  return {
    ...textOnlyBackend(name),
    promptWithImages: impl,
  } as unknown as ReasoningBackend;
}

const IMAGES: ReasoningImageAttachment[] = [{ path: '/tmp/page-1.png', media_type: 'image/png' }];
const TEST_REASONING_SCOPE = {
  tier: 'public' as const,
  purpose: 'hermetic reasoning vision test',
};

function withTestReasoningScope<T>(fn: () => Promise<T>): Promise<T> {
  return withReasoningPayloadScope(TEST_REASONING_SCOPE, fn);
}

describe('backendSupportsVision', () => {
  it('is false for a text-only backend', () => {
    expect(backendSupportsVision(textOnlyBackend('cli'))).toBe(false);
  });

  it('is true for a backend exposing the channel', () => {
    expect(backendSupportsVision(visionBackend('anthropic', async () => 'ok'))).toBe(true);
  });
});

describe('failover wrapper', () => {
  it('does not advertise vision when no candidate has it', () => {
    const failover = buildFailoverReasoningBackend([
      { backend: textOnlyBackend('a') },
      { backend: textOnlyBackend('b') },
    ]);
    expect(backendSupportsVision(failover)).toBe(false);
  });

  it('advertises vision when any candidate has it', () => {
    const failover = buildFailoverReasoningBackend([
      { backend: textOnlyBackend('a') },
      { backend: visionBackend('b', async () => 'ok') },
    ]);
    expect(backendSupportsVision(failover)).toBe(true);
  });

  it('routes to the vision-capable candidate, skipping text-only ones', async () => {
    const seen = vi.fn(async () => 'looked at it');
    const failover = buildFailoverReasoningBackend([
      { backend: textOnlyBackend('text-first') },
      { backend: visionBackend('vision', seen) },
    ]);
    const reply = await withTestReasoningScope(() =>
      failover.promptWithImages!('judge these', IMAGES)
    );
    expect(reply).toBe('looked at it');
    expect(seen).toHaveBeenCalledOnce();
  });

  it('passes the attachments through unchanged', async () => {
    let received: ReasoningImageAttachment[] = [];
    const failover = buildFailoverReasoningBackend([
      {
        backend: visionBackend('vision', async (_prompt, images) => {
          received = images;
          return 'ok';
        }),
      },
    ]);
    await withTestReasoningScope(() => failover.promptWithImages!('judge', IMAGES));
    expect(received).toEqual(IMAGES);
  });

  it('fails loudly rather than degrading when every vision candidate errors', async () => {
    const failover = buildFailoverReasoningBackend([
      { backend: textOnlyBackend('text') },
      {
        backend: visionBackend('vision', async () => {
          throw new Error('vision api down');
        }),
      },
    ]);
    await expect(
      withTestReasoningScope(() => failover.promptWithImages!('judge', IMAGES))
    ).rejects.toThrow(/promptWithImages failed/);
  });
});

describe('attachment bounds', () => {
  it('caps how many images one call may carry', () => {
    // A per-call cap keeps a 200-page deck from being sent whole.
    expect(MAX_REASONING_IMAGES).toBeGreaterThan(0);
    expect(MAX_REASONING_IMAGES).toBeLessThanOrEqual(50);
  });
});
