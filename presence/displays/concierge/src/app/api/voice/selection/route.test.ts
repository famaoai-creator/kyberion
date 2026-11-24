import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const core = vi.hoisted(() => ({
  getVoiceSelectionSnapshot: vi.fn(),
  saveVoiceSelectionPreferences: vi.fn(),
}));
const priority = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  denied: null as Response | null,
}));
vi.mock('@agent/core/seam-selection-rules', () => ({
  listSeamSelectionRules: priority.list,
  setSeamSelectionRule: priority.set,
  removeSeamSelectionRule: priority.remove,
}));
vi.mock('@agent/core/seam-provider-selection', () => ({
  getSeamSelectionPolicy: () => ({ providers: { local_say: {}, espeak_ng: {} } }),
}));
vi.mock('@agent/core/voice-engine-registry', () => ({
  listVoiceEngines: () =>
    ['local_say', 'espeak_ng'].map((engine_id) => ({
      engine_id,
      display_name: engine_id,
      supports: { playback: true },
    })),
  isLocalVoiceEngine: () => true,
  VOICE_TTS_ENGINE_SEAM: 'voice-tts-engine',
}));
vi.mock('../../../../lib/installation-access', () => ({
  requireConciergeInstallationAccess: () => ({ response: priority.denied }),
}));
const guard = vi.hoisted(() => ({ denied: null as Response | null }));
const roles = vi.hoisted(() => [] as string[]);
const viewer = vi.hoisted(() => ({ response: null as Response | null }));

vi.mock('@agent/shared-voice/voice-selection-preferences', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/shared-voice/voice-selection-preferences')
  >('@agent/shared-voice/voice-selection-preferences');
  return { ...core, voiceSelectionRequestSchema: actual.voiceSelectionRequestSchema };
});
vi.mock('@agent/core/authority', () => ({
  // S4: store facades open their declared store grant (withStoreGrant).
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
  withExecutionContext: vi.fn((role: string, fn: () => unknown) => {
    roles.push(role);
    return fn();
  }),
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => guard.denied),
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() =>
    viewer.response
      ? { response: viewer.response }
      : { context: { role: 'localadmin', tenantSlugs: 'all', principalId: 'owner' } }
  ),
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
    priority.denied = null;
    priority.list.mockReturnValue([]);
    roles.length = 0;
    viewer.response = null;
    core.getVoiceSelectionSnapshot.mockReturnValue(snapshot);
    core.saveVoiceSelectionPreferences.mockReturnValue(snapshot);
  });

  it('GET returns the selection without the internal storage path', async () => {
    const body = await (await GET(get())).json();
    expect(body).toMatchObject({ ok: true, preferences: snapshot.preferences });
    expect(body).not.toHaveProperty('storage_path');
    expect(roles).toEqual(['sovereign_concierge']);
  });

  it('GET is refused for an unresolved viewer', async () => {
    viewer.response = new Response('no', { status: 401 });
    expect((await GET(get())).status).toBe(401);
    expect(core.getVoiceSelectionSnapshot).not.toHaveBeenCalled();
  });

  it('POST saves a valid selection', async () => {
    const res = await POST(post({ stt_backend: 'whisper' }));
    expect(res.status).toBe(200);
    expect(core.saveVoiceSelectionPreferences).toHaveBeenCalledWith({ stt_backend: 'whisper' });
    // The personal profile is written as the Concierge personal-profile role.
    expect(roles).toEqual(['sovereign_concierge']);
    expect(await res.json()).not.toHaveProperty('storage_path');
  });

  it('saves an explicit playback order with actor and capability context', async () => {
    expect((await POST(post({ tts_priority: ['espeak_ng', 'local_say'] }))).status).toBe(200);
    expect(priority.set).toHaveBeenCalledWith({
      rule_id: 'concierge-local-voice-priority',
      seam: 'voice-tts-engine',
      when: { context: { operation: 'speak_local' } },
      prefer: ['espeak_ng', 'local_say'],
      set_by: 'owner',
    });
    expect((await POST(post({ tts_priority: [] }))).status).toBe(200);
    expect(priority.remove).toHaveBeenCalledWith('concierge-local-voice-priority');
    expect(core.saveVoiceSelectionPreferences).not.toHaveBeenCalled();
  });

  it('refuses unknown, duplicate or unauthorized priority updates', async () => {
    expect((await POST(post({ tts_priority: ['unknown'] }))).status).toBe(400);
    expect((await POST(post({ tts_priority: ['local_say', 'local_say'] }))).status).toBe(400);
    priority.denied = new Response('no', { status: 403 });
    expect((await POST(post({ tts_priority: ['local_say'] }))).status).toBe(403);
    expect(priority.set).not.toHaveBeenCalled();
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
      throw new Error('Unknown TTS engine: nope');
    });
    const res = await POST(post({ tts_engine_id: 'nope' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown TTS engine: nope');
  });

  it('POST hides a storage or role failure behind a 500', async () => {
    core.saveVoiceSelectionPreferences.mockImplementation(() => {
      throw new Error('[ROLE_VIOLATION] cannot write /Users/x/knowledge/personal/onboarding');
    });
    const res = await POST(post({ stt_backend: 'whisper' }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('/Users/x');
  });
});
