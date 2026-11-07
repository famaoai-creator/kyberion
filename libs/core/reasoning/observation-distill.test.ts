import { describe, expect, it } from 'vitest';
import { distillTextObservation, distillHttpResponse } from './observation-distill.js';

describe('distillTextObservation (AR-07)', () => {
  it('bounds head/tail and extracts error lines deterministically', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      i === 42 ? 'step 42: ERROR: connection refused' : `line ${i}`
    );
    const first = distillTextObservation(lines.join('\n'), {
      maxHeadLines: 5,
      maxTailLines: 5,
      maxErrorLines: 3,
    });
    const second = distillTextObservation(lines.join('\n'), {
      maxHeadLines: 5,
      maxTailLines: 5,
      maxErrorLines: 3,
    });
    expect(first).toEqual(second);
    expect(first.total_lines).toBe(100);
    expect(first.truncated).toBe(true);
    expect(first.head).toHaveLength(5);
    expect(first.tail).toHaveLength(5);
    expect(first.error_lines).toEqual(['step 42: ERROR: connection refused']);
  });

  it('keeps short output whole', () => {
    const result = distillTextObservation('ok\ndone');
    expect(result.truncated).toBe(false);
    expect(result.head).toEqual(['ok', 'done']);
    expect(result.tail).toEqual([]);
  });
});

describe('distillHttpResponse (AR-07)', () => {
  it('summarizes JSON bodies by shape', () => {
    const result = distillHttpResponse({ items: [1, 2, 3], next_cursor: 'abc', total: 3 });
    expect(result.kind).toBe('json');
    expect(result.json_shape).toEqual(['items', 'next_cursor', 'total']);
    expect(result.text_preview).toContain('next_cursor');
  });

  it('extracts title and links from HTML and strips tags', () => {
    const html =
      '<!doctype html><html><head><title>Login</title><style>.a{}</style></head>' +
      '<body><a href="/login">Sign in</a><a href="/reset">Reset</a><p>Welcome</p></body></html>';
    const result = distillHttpResponse(html);
    expect(result.kind).toBe('html');
    expect(result.title).toBe('Login');
    expect(result.links).toEqual(['/login', '/reset']);
    expect(result.text_preview).toContain('Welcome');
    expect(result.text_preview).not.toContain('<a');
  });

  it('previews plain text bodies with a cap', () => {
    const result = distillHttpResponse('x'.repeat(5000), { maxPreviewChars: 100 });
    expect(result.kind).toBe('text');
    expect(result.truncated).toBe(true);
    expect(result.text_preview).toHaveLength(100);
  });
});
