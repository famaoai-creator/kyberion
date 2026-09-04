import { describe, expect, it } from 'vitest';
import { extractExternalResponseText } from './surface-runtime-external-response.js';

describe('extractExternalResponseText', () => {
  it('keeps direct text responses unchanged', () => {
    expect(extractExternalResponseText('<h1>hello</h1>')).toBe('<h1>hello</h1>');
  });

  it('extracts text from provider body and data envelopes', () => {
    expect(extractExternalResponseText({ body: '<p>body</p>' })).toBe('<p>body</p>');
    expect(extractExternalResponseText({ data: '<p>data</p>' })).toBe('<p>data</p>');
  });

  it('serializes unknown provider payloads without object coercion', () => {
    expect(extractExternalResponseText({ data: { title: 'structured' } })).toBe(
      '{"data":{"title":"structured"}}'
    );
    expect(extractExternalResponseText(['unexpected', 7])).toBe('["unexpected",7]');
  });

  it('always returns text for values JSON cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(extractExternalResponseText(circular)).toBe('[Unserializable external response]');
  });
});
