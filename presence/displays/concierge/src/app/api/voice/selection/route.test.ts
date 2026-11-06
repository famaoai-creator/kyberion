import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const core = vi.hoisted(() => ({
  getVoiceSelectionSnapshot: vi.fn(),
  saveVoiceSelectionPreferences: vi.fn(),
}));
const guard = vi.hoisted(() => ({ denied: null as Response | null }));
const roles = vi.hoisted(() => [] as string[]);

vi.mock('@agent/core/voice/voice-selection-preferences', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/core/voice/voice-selection-preferences')
  >('@agent/core/voice/voice-selection-preferences');
  return { ...core, voiceSelectionRequestSchema: actual.voiceSelectionRequestSchema };
});
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((role: string, fn: () => unknown) => {
    roles.push(role);
    return fn();
  }),
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => guard.denied),
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({ context: { role: 'localadmin', tenantSlugs: 'all' } })),
  conciergeErrorResponse: vi.fn(() => new Response('error', { status: 500 })),
}));

import { GET, POST } from './route.js';

const snapshot = {
  preferences: { tts_engine_id: 'native', stt_backend: 'whisper' },
  storage_path: '/secret/profile/onboarding/voice-selection.json',
  tts_engines: [],
};
const post = (body: unknown) =>
  ({ headers: new Headers(), json: async () => body }) as unknown as NextRequest;
const get = () => ({ headers: new Headers() }) as unknown as NextRequest;

describe('/api/voice/selection (in-process)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guard.denied = null;
    core.getVoiceSelectionSnapshot.mockReturnValue(snapshot);
    core.saveVoiceSelectionPreferences.mockReturnValue(snapshot);
  });

  it('GET returns the selection without the internal storage path', async () => {
    const body = await (await GET(get())).json();
    expect(body).toMatchObject({ ok: true, preferences: snapshot.preferences });
    expect(body).not.toHaveProperty('storage_path');
  });

  it('POST saves a valid selection', async () => {
    const res = await POST(post({ stt_backend: 'whisper' }));
    expect(res.status).toBe(200);
    expect(core.saveVoiceSelectionPreferences).toHaveBeenCalledWith({ stt_backend: 'whisper' });
    // The personal profile is written as the Concierge personal-profile role.
    expect(roles).toContain('sovereign_concierge');
    expect(await res.json()).not.toHaveProperty('storage_path');
  });

  it('POST rejects an empty or unknown-key body before saving', async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ stt_backend: 'x', path: '/etc' }))).status).toBe(400);
    expect((await POST(post(null))).status).toBe(400);
    expect(core.saveVoiceSelectionPreferences).not.toHaveBeenCalled();
  });

  it('POST is refused without mutation access', async () => {
    guard.denied = new Response('no', { status: 403 });
    expect((await POST(post({ stt_backend: 'whisper' }))).status).toBe(403);
    expect(core.saveVoiceSelectionPreferences).not.toHaveBeenCalled();
  });

  it('POST reports an engine that cannot be selected as a 400', async () => {
    core.saveVoiceSelectionPreferences.mockImplementation(() => {
      throw new Error('unknown tts engine');
    });
    expect((await POST(post({ tts_engine_id: 'nope' }))).status).toBe(400);
  });
});
