import { describe, expect, it } from 'vitest';
import {
  readRequestObject,
  requireKnownFormKeys,
  requireKnownRequestKeys,
  requireRequestObject,
} from './request-input';

describe('readRequestObject', () => {
  it.each([
    ['malformed JSON', () => Promise.reject(new SyntaxError('invalid JSON'))],
    ['null', async () => null],
    ['array', async () => []],
    ['string', async () => 'body'],
  ])('rejects %s instead of treating it as an empty request', async (_label, json) => {
    await expect(readRequestObject({ json })).resolves.toMatchObject({ ok: false });
  });

  it('returns the object for route-specific validation', async () => {
    const body = { decision: 'approved', note: 'operator confirmed' };
    await expect(readRequestObject({ json: async () => body })).resolves.toEqual({
      ok: true,
      body,
    });
  });

  it('rejects unknown keys before route-specific defaults or side effects', async () => {
    await expect(
      readRequestObject(
        { json: async () => ({ decision: 'approved', debug: true }) },
        'request body',
        ['decision']
      )
    ).resolves.toEqual({
      ok: false,
      error: 'request body.debug is not supported',
    });
  });

  it('rejects unknown and prototype-shaped keys from the shared helper', () => {
    const body = requireRequestObject(JSON.parse('{"decision":"approved","__proto__":{}}'), 'body');
    expect(() => requireKnownRequestKeys(body, ['decision'], 'body')).toThrow(
      'body.__proto__ is not supported'
    );
    expect(() =>
      requireKnownRequestKeys({ decision: 'approved', constructor: 'bad' }, ['decision'], 'body')
    ).toThrow('body.constructor is not supported');
  });

  it('rejects unknown and duplicate multipart keys', () => {
    const form = new FormData();
    form.set('action', 'avatar');
    form.set('file', new File(['avatar'], 'avatar.png'));
    expect(() => requireKnownFormKeys(form, ['action', 'file'])).not.toThrow();

    form.set('redirect', 'https://example.test');
    expect(() => requireKnownFormKeys(form, ['action', 'file'])).toThrow(
      'form body.redirect is not supported'
    );

    form.delete('redirect');
    form.append('action', 'avatar');
    expect(() => requireKnownFormKeys(form, ['action', 'file'])).toThrow(
      'form body.action must appear once'
    );
  });
});
