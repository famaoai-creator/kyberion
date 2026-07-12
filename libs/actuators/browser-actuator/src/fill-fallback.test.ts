import { describe, expect, it, vi } from 'vitest';
import { fillWithFallback } from './browser-pipeline-helpers.js';

// AC-02: multi-strategy fill resolution with an actionable failure message.
function makePage(overrides: Record<string, unknown> = {}) {
  const failingFill = vi.fn(async () => {
    throw new Error('Timeout 5000ms exceeded');
  });
  const locatorChain = (fill: ReturnType<typeof vi.fn>) => ({
    first: () => ({ fill }),
  });
  return {
    fill: failingFill,
    getByLabel: vi.fn(() => locatorChain(vi.fn(async () => undefined))),
    getByPlaceholder: vi.fn(() => locatorChain(vi.fn(async () => undefined))),
    locator: vi.fn(() => locatorChain(vi.fn(async () => undefined))),
    evaluate: vi.fn(async () => ['input type=email name=user_email placeholder=Email']),
    ...overrides,
  } as never;
}

describe('fillWithFallback (AC-02)', () => {
  it('uses the direct selector when it works', async () => {
    const fill = vi.fn(async () => undefined);
    const page = makePage({ fill });
    const result = await fillWithFallback(page, {
      selector: '#email',
      text: 'x@example.com',
      timeoutMs: 100,
    });
    expect(result.strategy).toBe('selector');
    expect(fill).toHaveBeenCalledWith('#email', 'x@example.com', { timeout: 100 });
  });

  it('falls back to label resolution with a field hint', async () => {
    const page = makePage();
    const result = await fillWithFallback(page, {
      selector: 'input[type=email]',
      text: 'x@example.com',
      timeoutMs: 100,
      fieldHint: 'メールアドレス',
    });
    expect(result.strategy).toBe('label');
  });

  it('treats a plain-text selector as its own hint', async () => {
    const page = makePage();
    const result = await fillWithFallback(page, {
      selector: 'Email address',
      text: 'x@example.com',
      timeoutMs: 100,
    });
    expect(result.strategy).toBe('label');
  });

  it('lists visible input candidates when every strategy fails', async () => {
    const throwing = () => ({
      first: () => ({
        fill: vi.fn(async () => {
          throw new Error('not found');
        }),
      }),
    });
    const page = makePage({
      getByLabel: vi.fn(throwing),
      getByPlaceholder: vi.fn(throwing),
      locator: vi.fn(throwing),
    });
    await expect(
      fillWithFallback(page, {
        selector: 'input[type=email]',
        text: 'x',
        timeoutMs: 100,
        fieldHint: 'Email',
      })
    ).rejects.toThrow(/Visible input candidates: input type=email name=user_email/);
  });
});
