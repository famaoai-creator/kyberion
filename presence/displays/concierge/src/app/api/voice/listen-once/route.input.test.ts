import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => null),
}));
vi.mock('../../../../lib/voice-hub', () => ({
  voiceHubUrl: vi.fn(() => 'http://127.0.0.1:4173'),
}));

import { POST } from './route.js';

function request(body: unknown) {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}

describe('concierge listen-once input contract', () => {
  it.each([
    ['null body', null],
    ['array body', []],
    ['backend object', { backend: {} }],
    ['device array', { device: [] }],
    ['locale number', { locale: 1 }],
  ])('rejects %s before contacting voice-hub', async (_label, body) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid request body');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
