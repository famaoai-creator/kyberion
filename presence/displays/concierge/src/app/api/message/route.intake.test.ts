import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const fixtures = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  run: vi.fn(),
  viewer: {
    principalId: 'human:alice',
    role: 'localadmin' as const,
    source: 'token' as const,
    tenantSlugs: ['acme'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['public', 'confidential'] as Array<'public' | 'confidential'>,
  },
}));
vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: fixtures.viewer }),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/lock-utils', () => ({
  withLockSync: (_key: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(fixtures.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) =>
    fixtures.files.set(path, structuredClone(value)),
}));
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: fixtures.run,
}));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: (key: string) => key,
  resolveConciergeLocale: () => 'ja',
}));
import { POST } from './route';
async function say(text: string, requestId?: string) {
  const response = await POST(
    new NextRequest('http://localhost/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, locale: 'ja', ...(requestId ? { requestId } : {}) }),
    })
  );
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  fixtures.files.clear();
  fixtures.run.mockReset();
  fixtures.run.mockResolvedValue({ text: 'Chat reply' });
  fixtures.viewer.principalId = 'human:alice';
});
describe('Concierge intake through the real shared store', () => {
  it('keeps A and B across calls and restores a persisted clarification without model execution', async () => {
    const first = await say('Aの報告書を作って', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(first.body).toMatchObject({ mode: 'intake', historySaved: true });
    expect((await say('Bの旅行計画を作って')).body.mode).toBe('intake');
    const named = await say('Aの件どう？');
    expect(named.body).toMatchObject({ mode: 'intake', shape: 'status_summary' });
    expect(named.body.reply).toContain('A');
    const vague = await say('さっきの件どう？');
    expect(vague.body.shape).toBe('clarification');
    expect(vague.body.reply).toContain('A');
    expect(vague.body.reply).toContain('B');
    const selected = await say('1つ目');
    expect(selected.body.shape).toBe('status_summary');
    expect(selected.body.reply).toContain('A');
    const replay = await say('Aの報告書を作って', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(replay.body).toMatchObject({ mode: 'history', replayed: true, reply: first.body.reply });
    expect(fixtures.run).not.toHaveBeenCalled();
  });
  it('isolates a different principal and preserves ordinary chat routing', async () => {
    await say('Aの報告書を作って');
    fixtures.viewer.principalId = 'human:bob';
    const absent = await say('Aの件どう？');
    expect(absent.body.shape).toBe('clarification');
    expect(absent.body.reply).not.toContain('Aの報告書');
    expect(fixtures.run).not.toHaveBeenCalled();
    const chat = await say('hello');
    expect(chat.body).toMatchObject({ mode: 'orchestrator', reply: 'Chat reply' });
    expect(fixtures.run).toHaveBeenCalledOnce();
  });
});
