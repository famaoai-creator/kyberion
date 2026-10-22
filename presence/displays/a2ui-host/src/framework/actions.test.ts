import { describe, expect, it } from 'vitest';
import { inputActionBody, parseActionDescriptor, runAction, type FetchLike } from './actions.js';
import { extractA2UIPayload } from './envelope.js';

function fakeFetch(
  status: number,
  body: unknown,
  calls: Array<{ url: string; init?: RequestInit }>
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
}

describe('parseActionDescriptor', () => {
  it('accepts producer-relative api paths and defaults the method to POST', () => {
    expect(parseActionDescriptor({ operation_id: 'a.b', path: '/api/x/y?z=1' })).toEqual({
      operation_id: 'a.b',
      method: 'POST',
      path: '/api/x/y?z=1',
    });
    expect(
      parseActionDescriptor({
        operation_id: 'a',
        method: 'GET',
        path: '/api/x',
        refresh: false,
        body_field: 'answer',
      })
    ).toMatchObject({
      method: 'GET',
      refresh: false,
      body_field: 'answer',
    });
  });

  it('rejects absolute urls, other methods, bad ids and odd body fields', () => {
    expect(parseActionDescriptor({ operation_id: 'a', path: 'https://x/api' })).toBeNull();
    expect(parseActionDescriptor({ operation_id: 'a', path: '/other' })).toBeNull();
    expect(
      parseActionDescriptor({ operation_id: 'a', method: 'DELETE', path: '/api/x' })
    ).toBeNull();
    expect(parseActionDescriptor({ operation_id: 'Bad Id', path: '/api/x' })).toBeNull();
    expect(
      parseActionDescriptor({ operation_id: 'a', path: '/api/x', body_field: 'x y' })?.body_field
    ).toBeUndefined();
    expect(parseActionDescriptor(null)).toBeNull();
  });
});

describe('runAction', () => {
  it('posts the merged json body to the resolved target and reads the envelope ok flag', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await runAction(
      fakeFetch(200, { ok: true }, calls),
      (path) => `/api/providers/p/proxy${path}`,
      { operation_id: 'x', method: 'POST', path: '/api/do', body: { a: 1 } },
      { b: 2 }
    );
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe('/api/providers/p/proxy/api/do');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ a: 1, b: 2 });
  });

  it('treats envelope ok:false, http errors and network failures as failures without throwing', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const action = { operation_id: 'x', method: 'GET' as const, path: '/api/do' };
    expect((await runAction(fakeFetch(200, { ok: false }, calls), (p) => p, action)).ok).toBe(
      false
    );
    expect((await runAction(fakeFetch(500, null, calls), (p) => p, action)).status).toBe(500);
    const failing: FetchLike = async () => {
      throw new Error('offline');
    };
    const result = await runAction(failing, (p) => p, action);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(calls.every((call) => call.init?.body === undefined)).toBe(true);
  });

  it('refuses a tampered path at execution time', async () => {
    const result = await runAction(fakeFetch(200, {}, []), (p) => p, {
      operation_id: 'x',
      method: 'GET',
      path: '//evil.example/api',
    });
    expect(result.ok).toBe(false);
  });

  it('builds input bodies under the configured field', () => {
    expect(
      inputActionBody({ operation_id: 'x', method: 'POST', path: '/api/a' }, 'hi', 'r1')
    ).toEqual({
      text: 'hi',
      request_id: 'r1',
    });
    expect(
      inputActionBody(
        { operation_id: 'x', method: 'POST', path: '/api/a', body_field: 'answer' },
        'hi',
        'r1'
      ).answer
    ).toBe('hi');
  });
});

describe('extractA2UIPayload', () => {
  const message = { createSurface: { surfaceId: 's', catalogId: 'c' } };
  const input = { operation_id: 'in', method: 'POST', path: '/api/in', body_field: 'answer' };

  it('finds messages in every supported shape', () => {
    expect(extractA2UIPayload([message]).shape).toBe('array');
    expect(extractA2UIPayload({ a2ui: [message], input }).input?.body_field).toBe('answer');
    expect(
      extractA2UIPayload({ ok: true, data: { a2ui: [message], actions: [input, { bad: true }] } })
    ).toMatchObject({
      shape: 'envelope',
      actions: [{ operation_id: 'in' }],
    });
    expect(extractA2UIPayload({ ok: true, data: [message] }).messages).toEqual([message]);
    expect(extractA2UIPayload({ messages: [message] }).shape).toBe('messages');
  });

  it('returns an empty payload for anything else', () => {
    expect(extractA2UIPayload('text')).toEqual({
      messages: [],
      input: null,
      actions: [],
      shape: 'none',
    });
    expect(extractA2UIPayload({ ok: true, data: { other: 1 } }).messages).toEqual([]);
  });

  it('converts snapshot producers (single or keyed surfaces) into messages', () => {
    const keyed = extractA2UIPayload({
      surfaces: {
        'computer-surface': {
          catalogId: 'computer-surface',
          title: 'Computer Surface',
          components: [{ id: 'a', type: 'text', props: {} }],
          data: { status: 'idle' },
        },
        'Bad Id': { components: [] },
      },
      lastUpdatedAt: null,
    });
    expect(keyed.shape).toBe('snapshot');
    expect(keyed.messages).toEqual([
      {
        createSurface: {
          surfaceId: 'computer-surface',
          catalogId: 'computer-surface',
          title: 'Computer Surface',
        },
      },
      {
        updateComponents: {
          surfaceId: 'computer-surface',
          components: [{ id: 'a', type: 'text', props: {} }],
        },
      },
      { updateDataModel: { surfaceId: 'computer-surface', data: { status: 'idle' } } },
    ]);
    const single = extractA2UIPayload({ title: 'S', components: [], data: {} });
    expect(single.shape).toBe('snapshot');
    expect(single.messages[0]).toEqual({
      createSurface: { surfaceId: 'snapshot', catalogId: 'snapshot', title: 'S' },
    });
    // A component object is not a snapshot even though it has no `type`
    // at the top level only when `components` is present.
    expect(extractA2UIPayload({ id: 'x', type: 'text', props: {}, components: [] }).shape).toBe(
      'none'
    );
  });
});
