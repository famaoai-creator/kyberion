/* eslint-disable no-restricted-imports */
/**
 * ChromeExtensionMeetingJoinDriver — browser meeting attendance driven through
 * a user-loaded Chrome extension (the "Meet Copilot" extension in
 * tools/meet-copilot-extension), instead of Playwright/CDP.
 *
 * Why: Playwright/CDP sessions are rejected by Google Meet's bot detection.
 * A real, signed-in Chrome operated by the user's own extension is not.
 *
 * Control plane (inverted vs the native-messaging browser-bridge, which is
 * extension-initiated): this driver runs a LOCAL WebSocket server; the
 * extension's service worker connects to it and receives commands
 * (join / set_mic / set_camera / chat / leave) which the content script
 * executes against the Meet DOM by accessible-name. The extension streams
 * back events (ready / joined / caption / left / error).
 *
 * Audio is decoupled (same as the Playwright driver): the returned
 * MeetingSession pipes the supplied AudioBus (BlackHole) through — the user
 * routes Chrome's meeting audio to the virtual device. As a bonus, Meet's own
 * live captions scraped by the content script are persisted to a JSONL file so
 * a transcript is available even without a local STT model.
 */

import type { AudioBus } from './audio-bus.js';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { MeetingJoinDriver } from './meeting-join-driver.js';
import { registerMeetingJoinDriver } from './meeting-join-driver.js';
import type {
  AudioChunk,
  AudioFormat,
  MeetingSession,
  MeetingSessionState,
  MeetingTarget,
} from './meeting-session-types.js';
import { abortableAudioChunks } from './meeting-session-types.js';

export interface ChromeExtensionMeetingDriverOptions {
  /** Loopback port the driver listens on and the extension connects to. */
  wsPort?: number;
  /** Loopback host. Default 127.0.0.1. */
  wsHost?: string;
  /** Seconds to wait for the extension to connect + report the join. */
  joinTimeoutSec?: number;
  /** Start muted (listen-only, transcribe-first). Default true. */
  startMuted?: boolean;
  /** Start with camera off. Default true. */
  cameraOff?: boolean;
}

const DEFAULT_PORT = 8779;
const DEFAULT_HOST = '127.0.0.1';
const logger = createLogger('meet-ext');

interface ExtensionEvent {
  event: string;
  [k: string]: unknown;
}

// Minimal structural type so we don't hard-fail typecheck if `ws` types drift.
interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}
interface WsServerLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  close(cb?: () => void): void;
}

export class ChromeExtensionMeetingJoinDriver implements MeetingJoinDriver {
  readonly driver_id = 'chrome-extension';
  readonly supported_platforms = ['meet', 'teams', 'zoom', 'auto'] as const;

  constructor(private readonly options: ChromeExtensionMeetingDriverOptions = {}) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      await import('ws');
    } catch (err) {
      return {
        available: false,
        reason: `ws module not available (${(err as Error).message}); required for the extension control channel`,
      };
    }
    return { available: true };
  }

  async join(target: MeetingTarget, bus: AudioBus): Promise<MeetingSession> {
    const port = this.options.wsPort ?? DEFAULT_PORT;
    const host = this.options.wsHost ?? DEFAULT_HOST;
    const joinTimeoutMs = (this.options.joinTimeoutSec ?? 120) * 1000;
    const startMuted = this.options.startMuted !== false;
    const cameraOff = this.options.cameraOff !== false;

    const { WebSocketServer } = (await import('ws')) as unknown as {
      WebSocketServer: new (opts: { host: string; port: number }) => WsServerLike;
    };

    const captionsDir = pathResolver.shared('tmp');
    safeMkdir(captionsDir, { recursive: true });
    const sessionId = `meet-ext-${Date.now().toString(36)}`;
    const captionsPath = pathResolver.shared(`tmp/meeting-captions-${sessionId}.jsonl`);
    const diagnosticsPath = pathResolver.shared(`tmp/meeting-diagnostics-${sessionId}.json`);

    const state: MeetingSessionState = {
      session_id: sessionId,
      platform: 'meet',
      status: 'connecting',
      joined_at: new Date().toISOString(),
    };

    const wss = new WebSocketServer({ host, port });
    let socket: WsLike | null = null;
    const eventWaiters = new Map<string, Array<(e: ExtensionEvent) => void>>();

    const onEvent = (name: string, cb: (e: ExtensionEvent) => void): void => {
      const list = eventWaiters.get(name) ?? [];
      list.push(cb);
      eventWaiters.set(name, list);
    };
    const waitEvent = (name: string, timeoutMs: number): Promise<ExtensionEvent> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for extension event '${name}'`)),
          timeoutMs
        );
        onEvent(name, (e) => {
          clearTimeout(timer);
          resolve(e);
        });
      });
    const dispatch = (e: ExtensionEvent): void => {
      const list = eventWaiters.get(e.event);
      if (list && list.length > 0) {
        eventWaiters.set(e.event, []);
        for (const cb of list) cb(e);
      }
    };

    const send = (cmd: Record<string, unknown>): void => {
      if (!socket) throw new Error('extension is not connected to the control channel');
      socket.send(JSON.stringify(cmd));
    };

    const joinCmd = {
      cmd: 'join',
      url: target.url,
      platform: target.platform ?? 'auto',
      display_name: target.display_name ?? 'Kyberion',
      mic: startMuted ? 'off' : 'on',
      camera: cameraOff ? 'off' : 'on',
      captions: true,
    };

    let joinAcked = false;
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `no Chrome extension connected on ws://${host}:${port} within ${joinTimeoutMs / 1000}s. ` +
                `Load tools/meet-copilot-extension in Chrome and open the Meet tab.`
            )
          ),
        joinTimeoutMs
      );
      // Re-issue join on (re)connection ONLY until it is acknowledged, so the
      // operator can reload the extension before joining — but we never re-issue
      // join once in-call (repeated joins destabilize the Meet session).
      wss.on('connection', (...args: unknown[]) => {
        socket = args[0] as WsLike;
        clearTimeout(timer);
        socket.on('message', (...margs: unknown[]) => {
          try {
            const parsed = JSON.parse(String(margs[0])) as ExtensionEvent;
            if (parsed.event === 'joined') joinAcked = true;
            if (parsed.event === 'caption') {
              safeAppendFileSync(
                captionsPath,
                `${JSON.stringify({ ...parsed, ts: new Date().toISOString() })}\n`
              );
            }
            if (parsed.event === 'diagnostics') {
              safeWriteFile(diagnosticsPath, `${JSON.stringify(parsed.data ?? parsed, null, 2)}\n`);
              logger.info(`DOM diagnostics captured → ${diagnosticsPath}`);
            }
            if (parsed.event === 'status') {
              logger.info(
                `meeting status: ${String(parsed.phase ?? '')} ${JSON.stringify(parsed.detail ?? {})}`
              );
            }
            if (parsed.event === 'error') {
              logger.warn(`extension error: ${String(parsed.message ?? parsed.detail ?? '')}`);
            }
            dispatch(parsed);
          } catch {
            /* ignore malformed frames */
          }
        });
        socket.on('close', () => {
          state.status = state.status === 'ended' ? 'ended' : 'error';
        });
        if (!joinAcked) {
          logger.info(`extension connected on ws://${host}:${port}; issuing join`);
          try {
            socket.send(JSON.stringify(joinCmd));
          } catch {
            /* will retry on next connection */
          }
        } else {
          logger.info(
            `extension reconnected on ws://${host}:${port}; already joined (no re-issue)`
          );
        }
        resolve();
      });
      wss.on('error', (...eargs: unknown[]) => {
        clearTimeout(timer);
        reject(eargs[0] as Error);
      });
    });

    await connected;
    state.status = 'connecting';

    const joined = await waitEvent('joined', joinTimeoutMs).catch((err) => {
      throw new Error(`extension failed to join the meeting: ${(err as Error).message}`);
    });
    state.status = 'in_meeting';
    logger.info(
      `joined meeting (captions → ${captionsPath}) detail=${JSON.stringify(joined.detail ?? {})}`
    );

    // Open the audio bus defensively (idempotent per AudioBus contract).
    const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 };
    try {
      await bus.open(format);
    } catch (err) {
      logger.warn(
        `audio bus open failed (continuing; coordinator may have opened it): ${(err as Error).message}`
      );
    }

    let left = false;
    return {
      state,
      async *audioInput(): AsyncIterable<AudioChunk> {
        for await (const chunk of bus.inputStream()) {
          if (left) return;
          yield chunk;
        }
      },
      audioOutput: async (
        stream: AsyncIterable<AudioChunk>,
        signal?: AbortSignal
      ): Promise<void> => {
        // Speaking: the AI's TTS PCM is written to the bus (BlackHole), which the
        // operator has set as Chrome's microphone input for the meeting.
        await bus.writeOutput(abortableAudioChunks(stream, signal));
      },
      chat: async (text: string): Promise<void> => {
        try {
          send({ cmd: 'chat', text });
        } catch (err) {
          logger.warn(`chat send failed: ${(err as Error).message}`);
        }
      },
      leave: async (): Promise<void> => {
        left = true;
        try {
          // Register the waiter BEFORE sending so a fast 'left' reply isn't missed.
          const leftAck = waitEvent('left', 5_000).catch(() => undefined);
          send({ cmd: 'leave' });
          await leftAck;
        } catch {
          /* best-effort leave */
        } finally {
          state.status = 'ended';
          state.left_at = new Date().toISOString();
          try {
            socket?.close();
          } catch {
            /* noop */
          }
          // Guard wss.close: the callback may not fire while a client socket
          // lingers, so cap the wait.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 2_000);
            wss.close(() => {
              clearTimeout(t);
              resolve();
            });
          });
          await bus.close().catch(() => undefined);
        }
      },
    };
  }
}

export function installChromeExtensionMeetingJoinDriver(
  options?: ChromeExtensionMeetingDriverOptions
): void {
  registerMeetingJoinDriver(new ChromeExtensionMeetingJoinDriver(options));
}
