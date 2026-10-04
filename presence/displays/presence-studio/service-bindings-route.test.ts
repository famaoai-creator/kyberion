import { describe, expect, it, vi } from 'vitest';
import { registerServiceBindingsRoute } from './service-bindings-route.js';

function setup(resolveViewer: () => unknown) {
  let handler: ((request: unknown, response: ReturnType<typeof fakeResponse>) => void) | undefined;
  const app = {
    get: vi.fn((_path: string, route: typeof handler) => {
      handler = route;
    }),
  };
  const wireError = vi.fn((error: unknown, status: number) => ({ message: String(error), status }));
  registerServiceBindingsRoute({
    app: app as never,
    listBindings: () =>
      [
        {
          binding_id: 'org-acme',
          owner_kind: 'organization',
          owner_ref: 'acme',
          tenant_slug: 'acme',
        },
        {
          binding_id: 'org-beta',
          owner_kind: 'organization',
          owner_ref: 'beta',
          tenant_slug: 'beta',
        },
        { binding_id: 'person-alice', owner_kind: 'person', owner_ref: 'user:alice' },
        { binding_id: 'person-bob', owner_kind: 'person', owner_ref: 'user:bob' },
        { binding_id: 'operator', owner_kind: 'operator' },
      ] as never,
    resolveViewer: resolveViewer as never,
    wireError,
  });
  return { handler: () => handler!, wireError };
}

function fakeResponse() {
  const response: {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof response;
    json: (body: unknown) => typeof response;
  } = {
    statusCode: 200,
    body: undefined,
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(body) {
      response.body = body;
      return response;
    },
  };
  return response;
}

describe('GET /api/service-bindings', () => {
  it('filters organization and person bindings using the server-resolved viewer', () => {
    const route = setup(() => ({ principal: { memberId: 'alice' }, tenantSlugs: ['acme'] }));
    const response = fakeResponse();

    route.handler()({} as never, response);

    expect(response.body).toEqual({
      ok: true,
      items: [
        expect.objectContaining({ binding_id: 'org-acme' }),
        expect.objectContaining({ binding_id: 'person-alice' }),
      ],
    });
  });

  it('returns the viewer resolution error status and wire format', () => {
    const route = setup(() => {
      throw Object.assign(new Error('viewer unavailable'), { status: 503 });
    });
    const response = fakeResponse();

    route.handler()({} as never, response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ message: 'Error: viewer unavailable', status: 503 });
    expect(route.wireError).toHaveBeenCalledOnce();
  });
});
