/* eslint-disable no-restricted-imports */
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { StubAudioBus } from './audio-bus.js';
import { ChromeExtensionMeetingJoinDriver } from './chrome-extension-meeting-driver.js';
import { pathResolver } from './path-resolver.js';
import type { MeetingSession } from './meeting-session-types.js';

const WS_PORT = 8891;
const AUTH_TOKEN = 'test-meet-extension-auth-token-012345678901234567890';

/** Minimal stand-in for the extension's service worker. */
async function connectFakeExtension(authToken = AUTH_TOKEN): Promise<{
  send: (event: Record<string, unknown>) => Promise<void>;
  close: () => void;
}> {
  const { WebSocket } = (await import('ws')) as unknown as {
    WebSocket: new (url: string) => {
      on(event: string, cb: (...args: unknown[]) => void): void;
      send(data: string): void;
      close(): void;
    };
  };
  const socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  let controlToken = '';
  socket.on('message', (...args: unknown[]) => {
    try {
      const command = JSON.parse(String(args[0])) as {
        control_token?: string;
        event?: string;
      };
      if (typeof command.control_token === 'string') controlToken = command.control_token;
    } catch {
      // Ignore non-JSON frames in the test transport.
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', (err: unknown) => reject(err as Error));
  });
  socket.send(JSON.stringify({ event: 'hello', auth_token: authToken }));
  return {
    send: async (event) => {
      const deadline = Date.now() + 2_000;
      while (!controlToken && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      socket.send(JSON.stringify({ ...event, control_token: controlToken }));
    },
    close: () => socket.close(),
  };
}

describe('ChromeExtensionMeetingJoinDriver on-device AI events', () => {
  const opened: Array<{ session: MeetingSession; path: string }> = [];

  afterEach(async () => {
    for (const entry of opened.splice(0)) {
      await entry.session.leave().catch(() => undefined);
      rmSync(entry.path, { force: true });
    }
  });

  it('requires the pre-shared extension credential before opening the control session', async () => {
    const driver = new ChromeExtensionMeetingJoinDriver({ wsPort: WS_PORT, joinTimeoutSec: 1 });
    await expect(
      driver.join(
        { url: 'https://meet.google.com/abc-defg-hij', platform: 'meet' },
        new StubAudioBus()
      )
    ).rejects.toThrow(/KYBERION_MEET_EXTENSION_TOKEN/);
  });

  it('does not issue a join command to a client with the wrong credential', async () => {
    const driver = new ChromeExtensionMeetingJoinDriver({
      wsPort: WS_PORT,
      joinTimeoutSec: 5,
      wsAuthToken: AUTH_TOKEN,
    });
    const sessionPromise = driver.join(
      { url: 'https://meet.google.com/abc-defg-hij', platform: 'meet' },
      new StubAudioBus()
    );
    const wrong = await connectFakeExtension('wrong-meet-extension-auth-token-012345678901');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wrong).toBeDefined();
    const right = await connectFakeExtension();
    await right.send({ event: 'joined', detail: { platform: 'meet' } });
    const session = await sessionPromise;
    opened.push({
      session,
      path: pathResolver.shared(`tmp/meeting-summary-${session.state.session_id}.json`),
    });
    wrong.close();
    right.close();
  }, 15_000);

  it('persists side-panel AI output to a per-session summary document', async () => {
    const driver = new ChromeExtensionMeetingJoinDriver({
      wsPort: WS_PORT,
      joinTimeoutSec: 10,
      wsAuthToken: AUTH_TOKEN,
    });
    const bus = new StubAudioBus();
    const sessionPromise = driver.join(
      { url: 'https://meet.google.com/abc-defg-hij', platform: 'meet' },
      bus
    );

    const extension = await connectFakeExtension();
    await extension.send({ event: 'joined', detail: { platform: 'meet' } });
    const session = await sessionPromise;
    const summaryPath = pathResolver.shared(`tmp/meeting-summary-${session.state.session_id}.json`);
    opened.push({ session, path: summaryPath });

    await extension.send({
      event: 'ai_summary',
      provider: 'chrome-summarizer',
      text: '予算の合意は次回に持ち越し',
      mode: 'full',
    });
    await extension.send({
      event: 'ai_insights',
      provider: 'chrome-prompt',
      insights: { decisions: ['PoC を実施する'], review_required: true },
    });
    // The driver writes synchronously on receipt; give the socket a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const document = JSON.parse(readFileSync(summaryPath, 'utf8'));
    expect(document.session_id).toBe(session.state.session_id);
    expect(document.source).toBe('chrome-built-in-ai');
    expect(document.summary).toMatchObject({
      kind: 'summary',
      provider: 'chrome-summarizer',
      text: '予算の合意は次回に持ち越し',
    });
    expect(document.insights).toMatchObject({ kind: 'insights', provider: 'chrome-prompt' });
    expect(document.insights.insights.decisions).toEqual(['PoC を実施する']);
    expect(document.history).toHaveLength(2);
    expect(document.suggestions).toBeNull();

    extension.close();
  }, 20_000);
});
