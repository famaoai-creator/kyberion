import { afterAll, describe, expect, it } from 'vitest';
import { safeMkdir, safeUnlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { runAituberLiveSession } from './aituber_live_session.js';

const FIXTURE = 'active/shared/tmp/aituber-live-session-test-fixture.json';

function writeFixture(messages: unknown[]): string {
  const p = pathResolver.rootResolve(FIXTURE);
  safeMkdir(pathResolver.shared('tmp'), { recursive: true });
  safeWriteFile(p, JSON.stringify({ messages }));
  return FIXTURE;
}

afterAll(() => {
  safeUnlinkSync(pathResolver.rootResolve(FIXTURE));
});

const baseOptions = {
  sessionId: 'test-live-session',
  assistantName: 'Aoi',
  surfaceId: 'presence-studio',
  pollIntervalMs: 1,
  maxTurns: 10,
  deliveryMode: 'none' as const,
  personalVoiceMode: 'allow_fallback' as const,
  dryRun: false,
};

const noopPresence = async () => ({});

describe('runAituberLiveSession', () => {
  it('processes fixture messages through reply + presence path', async () => {
    const fixture = writeFixture([
      { id: 'm1', author: 'taro', text: 'こんにちは' },
      { id: 'm2', author: 'hanako', text: '会議にも出られるの？' },
    ]);
    const replies: string[] = [];
    const result = await runAituberLiveSession(
      { ...baseOptions, fixturePath: fixture },
      {
        replyFn: async (_s, text) => {
          replies.push(text);
          return 'はい、出られます';
        },
        speakFn: async () => ({ result: {} }),
        presenceFn: noopPresence,
      },
      () => {}
    );
    expect(result.turns).toBe(2);
    expect(result.processed).toEqual(['m1', 'm2']);
    expect(replies[0]).toContain('taro: こんにちは');
    expect(replies[1]).toContain('hanako:');
  });

  it('polls YouTube pages, dedupes overlapping messages, honors pollMs', async () => {
    const pages = [
      {
        items: [
          { id: 'a1', snippet: { displayMessage: 'hi' }, authorDetails: { displayName: 't' } },
        ],
        nextPageToken: 'p2',
        pollingIntervalMillis: 42,
      },
      {
        items: [
          { id: 'a1', snippet: { displayMessage: 'hi' }, authorDetails: { displayName: 't' } },
          { id: 'a2', snippet: { displayMessage: 'again' }, authorDetails: { displayName: 't' } },
        ],
      },
      { items: [] },
    ];
    let calls = 0;
    const fetchImpl = async () => {
      const payload = pages[Math.min(calls++, pages.length - 1)];
      return { ok: true, json: async () => payload } as Response;
    };
    const result = await runAituberLiveSession(
      { ...baseOptions, liveChatId: 'lc1', maxTurns: 2 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        apiKeyResolver: () => 'test-key',
        replyFn: async () => 'ok',
        speakFn: async () => ({ result: {} }),
        presenceFn: noopPresence,
        sleep: async () => {},
      },
      () => {}
    );
    expect(result.processed).toEqual(['a1', 'a2']);
  });

  it('continues after a transient poll error and a message-level failure', async () => {
    const fixture = writeFixture([
      { id: 'x1', author: 'a', text: 'fail me' },
      { id: 'x2', author: 'b', text: 'good' },
    ]);
    const result = await runAituberLiveSession(
      { ...baseOptions, fixturePath: fixture },
      {
        replyFn: async (_s, text) => {
          if (text.includes('fail me')) throw new Error('boom');
          return 'ok';
        },
        speakFn: async () => ({ result: {} }),
        presenceFn: noopPresence,
      },
      () => {}
    );
    expect(result.processed).toEqual(['x2']);
    expect(result.turns).toBe(1);
  });

  it('dry-run echoes without reasoning or TTS', async () => {
    const fixture = writeFixture([{ id: 'd1', author: 'x', text: 'test' }]);
    let replyCalls = 0;
    let speakCalls = 0;
    const result = await runAituberLiveSession(
      { ...baseOptions, fixturePath: fixture, dryRun: true },
      {
        replyFn: async () => {
          replyCalls += 1;
          return 'x';
        },
        speakFn: async () => {
          speakCalls += 1;
          return { result: {} };
        },
        presenceFn: noopPresence,
      },
      () => {}
    );
    expect(result.turns).toBe(1);
    expect(replyCalls).toBe(0);
    expect(speakCalls).toBe(0);
  });

  it('fails closed without API key or fixture (hermetic via injected resolver)', async () => {
    await expect(
      runAituberLiveSession(
        { ...baseOptions, liveChatId: 'lc1' },
        {
          apiKeyResolver: () => null,
          replyFn: async () => 'x',
          speakFn: async () => ({ result: {} }),
          presenceFn: noopPresence,
        },
        () => {}
      )
    ).rejects.toThrow(/KYBERION_YOUTUBE_API_KEY/);
  });
});
